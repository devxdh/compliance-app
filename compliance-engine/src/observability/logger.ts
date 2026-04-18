import pino, { type DestinationStream, type Logger } from "pino";
import { asWorkerError } from "../errors";

const REDACT_PATHS = [
  "authorization",
  "*.authorization",
  "headers.authorization",
  "req.headers.authorization",
  "apiToken",
  "*.apiToken",
  "token",
  "*.token",
  "masterKey",
  "*.masterKey",
  "hmacKey",
  "*.hmacKey",
  "kek",
  "*.kek",
  "encrypted_pii",
  "*.encrypted_pii",
  "encrypted_pii.data",
  "*.encrypted_pii.data",
  "encrypted_dek",
  "*.encrypted_dek",
  "payload.data",
  "*.payload.data",
  "payload.email",
  "*.payload.email",
  "payload.full_name",
  "*.payload.full_name",
  "email",
  "*.email",
  "full_name",
  "*.full_name",
];

function serializeErrorForLog(error: unknown) {
  const normalized = asWorkerError(error);
  return {
    ...normalized.toProblem(),
    stack: normalized.stack,
  };
}

export interface LoggerBindings {
  [key: string]: unknown;
}

export function createWorkerLogger(bindings: LoggerBindings = {}, destination?: DestinationStream): Logger {
  const instance = pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      messageKey: "message",
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        service: "dpdp-compliance-worker",
        plane: "data",
      },
      redact: {
        paths: REDACT_PATHS,
        censor: "[REDACTED]",
      },
      formatters: {
        level: (label) => ({ level: label }),
      },
      serializers: {
        err: serializeErrorForLog,
      },
    },
    destination
  );

  return Object.keys(bindings).length > 0 ? instance.child(bindings) : instance;
}

export const logger = createWorkerLogger();

export function getLogger(bindings: LoggerBindings): Logger {
  return logger.child(bindings);
}

export function logError(loggerInstance: Logger, error: unknown, message: string, bindings: LoggerBindings = {}) {
  const normalized = asWorkerError(error);
  const level = normalized.fatal ? "fatal" : normalized.retryable ? "warn" : "error";
  loggerInstance[level]({ ...bindings, err: normalized }, message);
  return normalized;
}
