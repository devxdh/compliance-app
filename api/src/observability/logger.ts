import pino, { type DestinationStream, type Logger } from "pino";
import { asApiError } from "../errors";

const REDACT_PATHS = [
  "authorization",
  "*.authorization",
  "headers.authorization",
  "req.headers.authorization",
  "body.email",
  "*.body.email",
  "payload.email",
  "*.payload.email",
  "payload.full_name",
  "*.payload.full_name",
  "signature.signatureBase64",
  "*.signature.signatureBase64",
];

function serializeErrorForLog(error: unknown) {
  const normalized = asApiError(error);
  return {
    ...normalized.toProblem(),
    stack: normalized.stack,
  };
}

export interface LoggerBindings {
  [key: string]: unknown;
}

export function createApiLogger(bindings: LoggerBindings = {}, destination?: DestinationStream): Logger {
  const instance = pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      messageKey: "message",
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        service: "dpdp-compliance-api",
        plane: "control",
      },
      redact: {
        paths: REDACT_PATHS,
        censor: "[REDACTED]",
      },
      formatters: {
        level: (label: string) => ({ level: label }),
      },
      serializers: {
        err: serializeErrorForLog,
      },
    },
    destination
  );

  return Object.keys(bindings).length > 0 ? instance.child(bindings) : instance;
}

export const logger = createApiLogger();

export function getLogger(bindings: LoggerBindings): Logger {
  return logger.child(bindings);
}

export function logError(loggerInstance: Logger, error: unknown, message: string, bindings: LoggerBindings = {}) {
  const normalized = asApiError(error);
  const level = normalized.fatal ? "fatal" : normalized.retryable ? "warn" : normalized.status >= 500 ? "error" : "warn";
  loggerInstance[level]({ ...bindings, err: normalized }, message);
  return normalized;
}
