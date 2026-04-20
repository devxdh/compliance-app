import type postgres from "postgres";
import type {
  CreateJobAndQueueTaskInput,
  CreatedJobRecord,
  ErasureJobRow,
  RepositoryContext,
  TaskQueueRow,
  TransitionJobFromOutboxInput,
} from "./repository.types";

/**
 * Fetches an erasure job by request id.
 *
 * @param context - Repository SQL context.
 * @param jobId - Erasure job UUID.
 * @returns Job row or `null`.
 */
export async function getJobById(
  context: RepositoryContext,
  jobId: string
): Promise<ErasureJobRow | null> {
  const [job] = await context.sql<ErasureJobRow[]>`
    SELECT *
    FROM ${context.sql(context.schema)}.erasure_jobs
    WHERE id = ${jobId}
  `;
  return job ?? null;
}

/**
 * Fetches an erasure job by idempotency key.
 *
 * @param context - Repository SQL context.
 * @param idempotencyKey - Request idempotency UUID.
 * @returns Job row or `null`.
 */
export async function getJobByIdempotencyKey(
  context: RepositoryContext,
  idempotencyKey: string
): Promise<ErasureJobRow | null> {
  const [job] = await context.sql<ErasureJobRow[]>`
    SELECT *
    FROM ${context.sql(context.schema)}.erasure_jobs
    WHERE idempotency_key = ${idempotencyKey}::uuid
  `;
  return job ?? null;
}

/**
 * Creates an erasure job and initial `VAULT_USER` task in one transaction.
 *
 * @param context - Repository SQL context.
 * @param input - Precomputed ids, normalized request payload, and timestamp.
 * @returns Inserted job and task rows.
 */
export async function createJobAndQueueTask(
  context: RepositoryContext,
  input: CreateJobAndQueueTaskInput
): Promise<CreatedJobRecord> {
  return context.sql.begin(async (tx) => {
    const [job] = await tx<ErasureJobRow[]>`
      INSERT INTO ${tx(context.schema)}.erasure_jobs (
        id,
        client_id,
        idempotency_key,
        subject_opaque_id,
        trigger_source,
        actor_opaque_id,
        legal_framework,
        request_timestamp,
        tenant_id,
        cooldown_days,
        shadow_mode,
        webhook_url,
        status,
        vault_due_at,
        created_at,
        updated_at
      )
      VALUES (
        ${input.jobId},
        ${input.clientId},
        ${input.request.idempotency_key}::uuid,
        ${input.request.subject_opaque_id},
        ${input.request.trigger_source},
        ${input.request.actor_opaque_id},
        ${input.request.legal_framework},
        ${new Date(input.request.request_timestamp)},
        ${input.request.tenant_id ?? null},
        ${input.request.cooldown_days},
        ${input.request.shadow_mode},
        ${input.request.webhook_url ?? null},
        'WAITING_COOLDOWN',
        NOW() + MAKE_INTERVAL(days := ${input.request.cooldown_days}),
        ${input.now},
        ${input.now}
      )
      RETURNING *
    `;

    const [task] = await tx<TaskQueueRow[]>`
      INSERT INTO ${tx(context.schema)}.task_queue (
        id,
        client_id,
        erasure_job_id,
        task_type,
        payload,
        status,
        attempt_count,
        next_attempt_at,
        created_at,
        updated_at
      )
      VALUES (
        ${input.taskId},
        ${input.clientId},
        ${input.jobId},
        'VAULT_USER',
        ${tx.json(input.payload as postgres.JSONValue)},
        'QUEUED',
        0,
        ${input.now},
        ${input.now},
        ${input.now}
      )
      RETURNING *
    `;

    return { job: job!, task: task! };
  });
}

/**
 * Cancels a job only when it is still in `WAITING_COOLDOWN`.
 *
 * @param context - Repository SQL context.
 * @param idempotencyKey - Request idempotency UUID.
 * @param now - Update timestamp.
 * @returns Cancelled job row or `null` if no eligible job was found.
 */
export async function cancelWaitingJobByIdempotencyKey(
  context: RepositoryContext,
  idempotencyKey: string,
  now: Date
): Promise<ErasureJobRow | null> {
  return context.sql.begin(async (tx) => {
    const [job] = await tx<ErasureJobRow[]>`
      UPDATE ${tx(context.schema)}.erasure_jobs
      SET status = 'CANCELLED',
          updated_at = ${now}
      WHERE idempotency_key = ${idempotencyKey}::uuid
        AND status = 'WAITING_COOLDOWN'
      RETURNING *
    `;

    if (!job) {
      return null;
    }

    await tx`
      UPDATE ${tx(context.schema)}.task_queue
      SET status = 'FAILED',
          completed_at = ${now},
          lease_expires_at = NULL,
          error_text = ${JSON.stringify({
            code: "API_TASK_CANCELLED",
            detail: "Task cancelled because erasure request moved to CANCELLED during cooldown.",
          })},
          updated_at = ${now}
      WHERE erasure_job_id = ${job.id}
        AND status IN ('QUEUED', 'DISPATCHED')
    `;

    return job;
  });
}

/**
 * Transitions erasure job state from worker outbox event semantics.
 *
 * @param context - Repository SQL context.
 * @param input - Job id, event type, and timestamps.
 */
export async function transitionJobFromOutbox(
  context: RepositoryContext,
  input: TransitionJobFromOutboxInput
): Promise<void> {
  const nextState =
    input.eventType === "USER_VAULTED"
      ? "VAULTED"
      : input.eventType === "NOTIFICATION_SENT"
        ? "NOTICE_SENT"
        : "SHREDDED";

  await context.sql`
    UPDATE ${context.sql(context.schema)}.erasure_jobs
    SET status = ${nextState},
        notification_due_at = CASE
          WHEN ${input.eventType === "USER_VAULTED"}
            THEN ${input.notificationDueAt ?? null}
          ELSE notification_due_at
        END,
        shred_due_at = CASE
          WHEN ${input.eventType === "USER_VAULTED"}
            THEN ${input.shredDueAt ?? null}
          ELSE shred_due_at
        END,
        shredded_at = CASE
          WHEN ${input.eventType === "SHRED_SUCCESS" || input.eventType === "USER_HARD_DELETED"}
            THEN ${input.shreddedAt ?? input.now}
          ELSE shredded_at
        END,
        updated_at = ${input.now}
    WHERE id = ${input.jobId}
  `;
}
