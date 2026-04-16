import express from "express";
import cors from "cors";
import { workerRouter } from "./features/worker/worker.router";

const app = express();

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/v1/worker', workerRouter);

export { app };