"use server";

import { revalidatePath } from "next/cache";
import { createWorkerClient, deactivateWorkerClient, requeueDeadLetterTask, rotateWorkerClientKey } from "@/lib/api-client";

export interface RequeueActionState {
  ok: boolean;
  message: string;
}

/**
 * Server Action that requeues a dead-letter task without exposing admin credentials to the browser.
 *
 * @param taskId - Control Plane task UUID.
 * @returns Action status for client components in later phases.
 */
export async function requeueDeadLetterAction(taskId: string): Promise<RequeueActionState> {
  try {
    await requeueDeadLetterTask(taskId);
    revalidatePath("/dashboard/dead-letters");
    return { ok: true, message: "Task requeued." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to requeue task.",
    };
  }
}

/**
 * Rotates one worker client's API key without exposing admin credentials to the browser.
 *
 * @param name - Stable worker client name.
 * @returns Action state containing the one-time replacement token when rotation succeeds.
 */
export async function rotateWorkerKeyAction(name: string): Promise<RequeueActionState & { bearerToken?: string }> {
  try {
    const rotated = await rotateWorkerClientKey(name);
    revalidatePath("/dashboard/workers");
    return {
      ok: true,
      message: `Rotated key for ${rotated.client.name}. Store the token immediately; it is shown once.`,
      bearerToken: rotated.bearer_token,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Worker key rotation failed.",
    };
  }
}

/**
 * Creates a worker client through the server-only admin API boundary.
 *
 * @param formData - Client creation form data.
 * @returns Action state containing the one-time worker token when creation succeeds.
 */
export async function createWorkerClientAction(
  formData: FormData
): Promise<RequeueActionState & { bearerToken?: string }> {
  const name = String(formData.get("name") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();

  if (!name) {
    return {
      ok: false,
      message: "Client name is required.",
    };
  }

  try {
    const created = await createWorkerClient({
      name,
      displayName: displayName || undefined,
    });
    revalidatePath("/dashboard/clients");
    revalidatePath("/dashboard/workers");
    return {
      ok: true,
      message: `Created client ${created.client.name}. Store the worker token immediately; it is shown once.`,
      bearerToken: created.bearer_token,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Client creation failed.",
    };
  }
}

/**
 * Deactivates a worker client while preserving audit lineage.
 *
 * @param name - Stable worker client name.
 * @returns Action state for operator feedback.
 */
export async function deactivateWorkerClientAction(name: string): Promise<RequeueActionState> {
  try {
    const client = await deactivateWorkerClient(name);
    revalidatePath("/dashboard/clients");
    revalidatePath("/dashboard/workers");
    return {
      ok: true,
      message: `Deactivated ${client.name}. Existing audit rows remain immutable.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Client deactivation failed.",
    };
  }
}
