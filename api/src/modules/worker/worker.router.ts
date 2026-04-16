import { Router } from "express";
import { receiveOutbox, syncWorker } from "./worker.controller";

const router = Router();

router.get("/sync", syncWorker);
router.post("/outbox", receiveOutbox);

export { router as workerRouter };
