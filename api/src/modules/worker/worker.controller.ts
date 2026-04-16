import type { Request, Response } from "express";
import type { JsonObject } from "../../types/common";
import { WorkerService } from "./worker.service";
import { workerRepository } from "./worker.repository";
import {
  ackTaskSchema,
  clientIdHeaderSchema,
  enqueueTaskSchema,
  outboxIngestSchema,
  paginationQuerySchema,
} from "./worker.schemas";

/**
 * 
 * Controller functions translate HTTP requests into worker operations.
 *
 * 
 * Thin transport layer handling validation, status codes, and response mapping.
 */
function getClientId(req: Request): string | null {
  const raw = req.headers["x-client-id"] ?? req.query.client_id;
  const parsed = clientIdHeaderSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * 
 * Reads path parameters safely and avoids accidental array values.
 *
 * 
 * Normalizes Express route param union into nullable string.
 */
function getRouteParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const workerService = new WorkerService(workerRepository);

export async function syncWorker(req: Request, res: Response): Promise<void> {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "x-client-id header is required" });
    return;
  }

  try {
    const fastPath = await workerService.syncWorker(clientId);
    if (fastPath.pending) {
      res.json(fastPath);
      return;
    }

    const result = await workerService.waitForTask(clientId);
    res.json(result);
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

  const parsedBody = outboxIngestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "event_type and payload are required" });
    return;
  }

  try {
    const { event_type, payload, idempotency_key } = parsedBody.data;
    const { created, event } = await workerService.receiveOutbox(
      clientId,
      event_type,
      payload as JsonObject,
      idempotency_key ?? null
    );
    res.status(created ? 201 : 200).json({ success: true, deduplicated: !created, event });
  } catch (error) {
    console.error("Error in receiveOutbox:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function createTask(req: Request, res: Response): Promise<void> {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "x-client-id header is required" });
    return;
  }

  const parsedBody = enqueueTaskSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "task_type and payload are required" });
    return;
  }

  try {
    const { task_type, payload } = parsedBody.data;
    const task = await workerService.enqueueTask(clientId, task_type, payload as JsonObject);
    res.status(201).json({ success: true, task });
  } catch (error) {
    console.error("Error in createTask:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function getTask(req: Request, res: Response): Promise<void> {
  const taskId = getRouteParam(req.params.taskId);
  if (!taskId) {
    res.status(400).json({ error: "taskId is required" });
    return;
  }

  try {
    const task = await workerService.getTask(taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.status(200).json({ success: true, task });
  } catch (error) {
    console.error("Error in getTask:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function ackTask(req: Request, res: Response): Promise<void> {
  const taskId = getRouteParam(req.params.taskId);
  if (!taskId) {
    res.status(400).json({ error: "taskId is required" });
    return;
  }

  const parsedBody = ackTaskSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "status must be completed, failed, or cancelled" });
    return;
  }

  try {
    const { status, result, error } = parsedBody.data;
    const task = await workerService.ackTask(taskId, status, (result as JsonObject | undefined) ?? null, error ?? null);
    if (!task) {
      res.status(404).json({ error: "Task not found or not claimable" });
      return;
    }
    res.status(200).json({ success: true, task });
  } catch (error) {
    console.error("Error in ackTask:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function listOutboxEvents(req: Request, res: Response): Promise<void> {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "x-client-id header is required" });
    return;
  }

  const parsedQuery = paginationQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: "invalid pagination query" });
    return;
  }

  try {
    const { limit, offset } = parsedQuery.data;
    const events = await workerService.listOutboxEvents(clientId, limit, offset);
    res.status(200).json({ success: true, events, pagination: { limit, offset, count: events.length } });
  } catch (error) {
    console.error("Error in listOutboxEvents:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
