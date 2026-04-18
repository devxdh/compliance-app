import type { Logger } from "pino";
import { asWorkerError } from "../errors";
import { logError } from "../observability/logger";

function terminate(logger: Logger, error: unknown, code: number) {
  const normalized = asWorkerError(error, {
    code: "DPDP_RUNTIME_FATAL",
    title: "Fatal runtime error",
    detail: "A fatal runtime error reached the process boundary.",
    category: "runtime",
    fatal: true,
  });
  logError(logger, normalized, "Fatal runtime error reached process boundary");
  process.exit(code);
}

export function registerProcessGuards(logger: Logger) {
  process.on("unhandledRejection", (reason) => {
    terminate(logger, asWorkerError(reason, {
      code: "DPDP_RUNTIME_UNHANDLED_REJECTION",
      title: "Unhandled promise rejection",
      detail: "An unhandled promise rejection reached the process boundary.",
      category: "runtime",
      fatal: true,
    }), 1);
  });

  process.on("uncaughtException", (error) => {
    terminate(logger, asWorkerError(error, {
      code: "DPDP_RUNTIME_UNCAUGHT_EXCEPTION",
      title: "Uncaught exception",
      detail: "An uncaught exception reached the process boundary.",
      category: "runtime",
      fatal: true,
    }), 1);
  });
}
