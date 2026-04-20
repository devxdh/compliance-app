import { setTimeout as sleep } from "node:timers/promises";

const composeArgs = ["compose", "-f", "docker-compose.yml"];
const apiBaseUrl = process.env.DPDP_LOCAL_API_URL ?? "http://127.0.0.1:13000";
const gatewayBaseUrl = process.env.DPDP_LOCAL_GATEWAY_URL ?? "http://127.0.0.1:18080";
const keepUp = process.env.DPDP_E2E_KEEP_UP === "1";

interface ErasureCreateResponse {
  request_id: string;
  task_id: string;
  accepted_at: string;
}

interface GatewayEvent {
  type: "mail" | "webhook";
}

function run(command: string[], check: boolean = true): string {
  const proc = Bun.spawnSync(command, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (check && proc.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed\n${stdout}\n${stderr}`.trim());
  }

  return stdout.trim();
}

function assertUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Expected UUID, received ${value}`);
  }

  return value;
}

function psql(query: string): string {
  return run(
    [
      "docker",
      "exec",
      "compliance-app-postgres-1",
      "psql",
      "-U",
      "dpdp",
      "-d",
      "dpdp_local",
      "-t",
      "-A",
      "-c",
      query,
    ],
    true
  );
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until deadline.
    }
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForCertificate(requestId: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${apiBaseUrl}/api/v1/certificates/${requestId}`);
    if (response.status === 200) {
      return response;
    }
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for certificate ${requestId}`);
}

async function waitForJobStatus(
  requestId: string,
  expectedStatus: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = psql(
      `SELECT status FROM dpdp_control.erasure_jobs WHERE id = '${assertUuid(requestId)}'`
    ).trim();
    if (status === expectedStatus) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for job ${requestId} to reach ${expectedStatus}`);
}

async function waitForMailEvent(timeoutMs: number): Promise<GatewayEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${gatewayBaseUrl}/events`);
    const gatewayEvents = (await response.json()) as GatewayEvent[];
    if (gatewayEvents.some((event) => event.type === "mail")) {
      return gatewayEvents;
    }

    await sleep(1_000);
  }

  throw new Error("Timed out waiting for a mail event in mock gateway.");
}

function accelerateNotificationPhase(requestId: string): void {
  const safeRequestId = assertUuid(requestId);
  psql(`
    UPDATE dpdp_control.erasure_jobs
    SET notification_due_at = NOW(),
        shred_due_at = NOW() + INTERVAL '5 seconds'
    WHERE id = '${safeRequestId}';

    UPDATE dpdp_engine.pii_vault
    SET notification_due_at = NOW(),
        retention_expiry = NOW() + INTERVAL '5 seconds'
    WHERE request_id = '${safeRequestId}';
  `);
}

function accelerateShredPhase(requestId: string): void {
  const safeRequestId = assertUuid(requestId);
  psql(`
    UPDATE dpdp_control.erasure_jobs
    SET shred_due_at = NOW()
    WHERE id = '${safeRequestId}';

    UPDATE dpdp_engine.pii_vault
    SET retention_expiry = NOW()
    WHERE request_id = '${safeRequestId}';
  `);
}

async function main(): Promise<void> {
  try {
    run(["docker", ...composeArgs, "down", "-v"], false);
    run(["docker", ...composeArgs, "up", "-d", "--build", "postgres", "mock-gateway"]);
    await waitForUrl(`${gatewayBaseUrl}/healthz`, 30_000);
    await fetch(`${gatewayBaseUrl}/events`, { method: "DELETE" });

    run(["bun", "run", "scripts/render-local-worker-config.ts"]);

    run(["docker", ...composeArgs, "up", "-d", "--build", "api", "worker", "prometheus", "alertmanager", "grafana"]);
    await waitForUrl(`${apiBaseUrl}/ready`, 60_000);
    await waitForUrl("http://127.0.0.1:19464/readyz", 60_000);

    const createResponse = await fetch(`${apiBaseUrl}/api/v1/erasure-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject_opaque_id: "usr_local_zero",
        idempotency_key: crypto.randomUUID(),
        trigger_source: "USER_CONSENT_WITHDRAWAL",
        actor_opaque_id: "usr_local_zero",
        legal_framework: "DPDP_2023",
        request_timestamp: new Date().toISOString(),
        cooldown_days: 0,
        shadow_mode: false,
      }),
    });

    if (createResponse.status !== 202) {
      throw new Error(`Unexpected create response: ${createResponse.status} ${await createResponse.text()}`);
    }

    const created = (await createResponse.json()) as ErasureCreateResponse;
    await waitForJobStatus(created.request_id, "VAULTED", 90_000);
    accelerateNotificationPhase(created.request_id);
    const gatewayEvents = await waitForMailEvent(90_000);
    await waitForJobStatus(created.request_id, "NOTICE_SENT", 90_000);
    accelerateShredPhase(created.request_id);
    const certificateResponse = await waitForCertificate(created.request_id, 90_000);
    const certificate = (await certificateResponse.json()) as { request_id: string; method: string };

    const apiMetricsResponse = await fetch(`${apiBaseUrl}/metrics`);
    const workerMetricsResponse = await fetch("http://127.0.0.1:19464/metrics");
    if (!apiMetricsResponse.ok || !workerMetricsResponse.ok) {
      throw new Error("Metrics endpoints did not respond successfully.");
    }

    console.log(
      JSON.stringify(
        {
          request_id: created.request_id,
          certificate_method: certificate.method,
          mail_events: gatewayEvents.filter((event) => event.type === "mail").length,
          api_metrics: apiMetricsResponse.status,
          worker_metrics: workerMetricsResponse.status,
        },
        null,
        2
      )
    );
  } finally {
    if (!keepUp) {
      run(["docker", ...composeArgs, "down", "-v"], false);
    }
  }
}

await main();
