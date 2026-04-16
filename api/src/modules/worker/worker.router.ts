import { Router } from "express";
import { ackTask, createTask, getTask, listOutboxEvents, receiveOutbox, syncWorker } from "./worker.controller";

const router = Router();

router.get("/sync", syncWorker);
router.post("/outbox", receiveOutbox);
router.get("/outbox/events", listOutboxEvents);
router.post("/tasks", createTask);
router.get("/tasks/:taskId", getTask);
router.post("/tasks/:taskId/ack", ackTask);

export { router as workerRouter };
