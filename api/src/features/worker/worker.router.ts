import { Router } from 'express';
import { syncWorker, receiveOutbox } from './worker.controller';

const router = Router();

// Long-Polling sync endpoint
router.get('/sync', syncWorker);

// Outbox manifest receiver endpoint
router.post('/outbox', receiveOutbox);

export { router as workerRouter };
