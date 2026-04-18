import { Hono } from "hono";
import type postgres from "postgres";
import type { CoeSigner } from "./crypto/coe";
import { ControlPlaneRepository } from "./modules/control-plane/repository";
import { createControlPlaneRouter } from "./modules/control-plane/router";
import { ControlPlaneService } from "./modules/control-plane/service";

export interface CreateAppOptions {
  sql: postgres.Sql;
  controlSchema: string;
  signer: CoeSigner;
  taskLeaseSeconds?: number;
}

/**
 * Builds the Hono application for the control plane.
 */
export function createApp(options: CreateAppOptions) {
  const app = new Hono();
  const repository = new ControlPlaneRepository(
    options.sql,
    options.controlSchema,
    options.taskLeaseSeconds ?? 60
  );
  const service = new ControlPlaneService({
    repository,
    signer: options.signer,
  });

  app.get("/health", (c) => c.json({ ok: true }, 200));
  app.route("/api/v1", createControlPlaneRouter(service));

  return app;
}

