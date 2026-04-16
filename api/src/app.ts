import express from "express";
import cors from "cors";
import { workerRouter } from "./modules/worker/worker.router";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// API Routes
app.use('/api/v1/worker', workerRouter);

export { app };