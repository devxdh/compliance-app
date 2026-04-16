import type { Request, Response } from "express";
import { z } from "zod";
import { sql } from "../../db/index";
import { eventBus } from "../../utils/event-bus";

const longPollTimeoutMs = 25_000;

const outboxPayloadSchema = z.object({
  event_type: z.string().min(1),
  payload: z.record(z.string(), z.any()),
});

function getClientId(req: Request): string | null {
  const raw = req.headers["x-client-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function syncWorker(req: Request, res: Response): Promise<void> {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "x-client-id header is required" });
    return;
  }

  try {
    const tasks = await sql`
      SELECT * FROM pending_tasks
      WHERE client_id = ${clientId} AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    if (tasks.length > 0) {
      const task = tasks[0];
      await sql`UPDATE pending_tasks SET status = 'claimed' WHERE id = ${task?.id}`;
      res.json({ pending: true, task });
      return;
    }

    const channelName = `task_ready_${clientId}`;
    let isResolved = false;

    const onNewTask = (taskData: unknown) => {
      if (isResolved) {
        return;
      }
      isResolved = true;
      clearTimeout(timeout);
      eventBus.removeListener(channelName, onNewTask);
      res.json({ pending: true, task: taskData });
    };

    eventBus.once(channelName, onNewTask);

    const timeout = setTimeout(() => {
      if (isResolved) {
        return;
      }
      isResolved = true;
      eventBus.removeListener(channelName, onNewTask);
      res.json({ pending: false });
    }, longPollTimeoutMs);

    req.on("close", () => {
      if (isResolved) {
        return;
      }
      isResolved = true;
      clearTimeout(timeout);
      eventBus.removeListener(channelName, onNewTask);
    });
  } catch (error) {
    console.error("Error in syncWorker:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function receiveOutbox(req: Request, res: Response): Promise<void> {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "x-client-id header is required" });
    return;
  }

  const parsedBody = outboxPayloadSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "event_type and payload are required" });
    return;
  }

  try {
    const { event_type, payload } = parsedBody.data;
    const events = await sql`
      INSERT INTO worker_outbox_events (client_id, event_type, payload)
      VALUES (${clientId}, ${event_type}, ${sql.json(JSON.parse(JSON.stringify(payload)))})
      RETURNING id, event_type, processed_at
    `;

    res.status(201).json({ success: true, event: events[0] });
  } catch (error) {
    console.error("Error in receiveOutbox:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
