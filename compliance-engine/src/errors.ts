import { ZodError } from "zod";
import { formatZodIssues, summarizeZodError, type WorkerValidationIssue } from "./validation/zod";

export type WorkerErrorCode = `DPDP_${string}`;

export type WorkerErrorCategory =
  | "configuration"
  | "validation"
  | "integrity"
  | "concurrency"
  | "database"
  | "network"
  | "crypto"
  | "runtime"
  | "external"
  | "internal";

export interface WorkerErrorContext {
  [key: string]: unknown;
}

export interface WorkerProblemDetails {
  type: string;
  title: string;
  detail: string;
  code: WorkerErrorCode;
  category: WorkerErrorCategory;
  retryable: boolean;
  fatal: boolean;
  instance?: string;
  context?: WorkerErrorContext;
  issues?: WorkerValidationIssue[];
  cause?: WorkerProblemDetails;
}

export interface WorkerErrorOptions {
  code: WorkerErrorCode;
  title: string;
  detail: string;
  category: WorkerErrorCategory;
  retryable?: boolean;
  fatal?: boolean;
  context?: WorkerErrorContext;
  issues?: WorkerValidationIssue[];
  cause?: unknown;
  type?: string;
}

export interface WorkerErrorFallback {
  code?: WorkerErrorCode;
  title?: string;
  detail?: string;
  category?: WorkerErrorCategory;
  retryable?: boolean;
  fatal?: boolean;
  context?: WorkerErrorContext;
  issues?: WorkerValidationIssue[];
}

const RETRYABLE_POSTGRES_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

function normalizeErrorType(code: WorkerErrorCode): string {
  return `urn:dpdp:worker:error:${code.toLowerCase().replace(/^dpdp_/, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPostgresError(value: unknown): value is Error & { code: string } {
  return value instanceof Error && typeof (value as { code?: unknown }).code === "string";
}

function getErrorCause(error: Error): unknown {
  return (error as Error & { cause?: unknown }).cause;
}

function isAbortLikeError(value: unknown): value is Error {
  return value instanceof Error && (value.name === "AbortError" || value.name === "TimeoutError");
}

function isWorkerProblem(value: unknown): value is WorkerProblemDetails {
  return isRecord(value) && typeof value.code === "string" && typeof value.detail === "string";
}

function inferRetryability(error: unknown, fallback?: WorkerErrorFallback): boolean {
  if (fallback?.retryable !== undefined) {
    return fallback.retryable;
  }

  if (isAbortLikeError(error)) {
    return true;
  }

  if (isPostgresError(error)) {
    if (error.code.startsWith("08")) {
      return true;
    }

    return RETRYABLE_POSTGRES_CODES.has(error.code);
  }

  return false;
}

function inferCategory(error: unknown, fallback?: WorkerErrorFallback): WorkerErrorCategory {
  if (fallback?.category) {
    return fallback.category;
  }

  if (error instanceof ZodError) {
    return "validation";
  }

  if (isAbortLikeError(error)) {
    return "network";
  }

  if (isPostgresError(error)) {
    if (error.code === "40001" || error.code === "40P01" || error.code === "55P03") {
      return "concurrency";
    }

    if (error.code.startsWith("08") || error.code.startsWith("57")) {
      return "database";
    }

    return "database";
  }

  return "internal";
}

function inferFatal(error: unknown, fallback?: WorkerErrorFallback): boolean {
  if (fallback?.fatal !== undefined) {
    return fallback.fatal;
  }

  if (error instanceof WorkerError) {
    return error.fatal;
  }

  return false;
}

function inferTitle(error: unknown, fallback?: WorkerErrorFallback): string {
  if (fallback?.title) {
    return fallback.title;
  }

  if (error instanceof ZodError) {
    return "Validation failed";
  }

  if (isAbortLikeError(error)) {
    return "Network operation timed out";
  }

  if (isPostgresError(error) && error.code === "40001") {
    return "Serialization failure";
  }

  if (error instanceof Error && error.name) {
    return error.name;
  }

  return "Unexpected worker error";
}

function inferDetail(error: unknown, fallback?: WorkerErrorFallback): string {
  if (fallback?.detail) {
    return fallback.detail;
  }

  if (error instanceof ZodError) {
    return summarizeZodError(error);
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "An unexpected worker error occurred.";
}

function inferCode(error: unknown, fallback?: WorkerErrorFallback): WorkerErrorCode {
  if (fallback?.code) {
    return fallback.code;
  }

  if (error instanceof WorkerError) {
    return error.code;
  }

  if (error instanceof ZodError) {
    return "DPDP_VALIDATION_FAILED";
  }

  if (isAbortLikeError(error)) {
    return "DPDP_NETWORK_TIMEOUT";
  }

  if (isPostgresError(error)) {
    if (error.code === "40001") {
      return "DPDP_DB_SERIALIZATION_FAILURE";
    }

    if (error.code === "40P01") {
      return "DPDP_DB_DEADLOCK_DETECTED";
    }

    if (error.code === "55P03") {
      return "DPDP_DB_LOCK_NOT_AVAILABLE";
    }

    if (error.code.startsWith("08")) {
      return "DPDP_DB_CONNECTION_ERROR";
    }

    return "DPDP_DB_ERROR";
  }

  return "DPDP_INTERNAL_UNEXPECTED";
}

function buildCause(cause: unknown): Error | undefined {
  if (cause instanceof Error) {
    return cause;
  }

  if (cause === undefined) {
    return undefined;
  }

  return new Error(typeof cause === "string" ? cause : JSON.stringify(cause));
}

/**
 * Canonical worker error envelope mapped to RFC-7807-compatible problem details.
 */
export class WorkerError extends Error {
  readonly type: string;
  readonly code: WorkerErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly category: WorkerErrorCategory;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly context?: WorkerErrorContext;
  readonly issues?: WorkerValidationIssue[];

  constructor(options: WorkerErrorOptions) {
    super(options.detail, { cause: buildCause(options.cause) });
    this.name = "WorkerError";
    this.type = options.type ?? normalizeErrorType(options.code);
    this.code = options.code;
    this.title = options.title;
    this.detail = options.detail;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.fatal = options.fatal ?? false;
    this.context = options.context;
    this.issues = options.issues;
  }

  toProblem(instance?: string): WorkerProblemDetails {
    const cause = this.cause ? asWorkerError(this.cause).toProblem() : undefined;

    return {
      type: this.type,
      title: this.title,
      detail: this.detail,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      fatal: this.fatal,
      ...(instance ? { instance } : {}),
      ...(this.context ? { context: this.context } : {}),
      ...(this.issues ? { issues: this.issues } : {}),
      ...(cause ? { cause } : {}),
    };
  }
}

/**
 * Type guard for `WorkerError`.
 *
 * @param error - Unknown thrown value.
 * @returns `true` when value is a `WorkerError`.
 */
export function isWorkerError(error: unknown): error is WorkerError {
  return error instanceof WorkerError;
}

/**
 * Constructs a normalized `WorkerError`.
 *
 * @param options - Error metadata and classification.
 * @returns Worker error instance.
 */
export function workerError(options: WorkerErrorOptions): WorkerError {
  return new WorkerError(options);
}

/**
 * Throws a normalized `WorkerError`.
 *
 * @param options - Error metadata and classification.
 * @throws {WorkerError} Always.
 */
export function fail(options: WorkerErrorOptions): never {
  throw workerError(options);
}

/**
 * Normalizes unknown errors into `WorkerError`, applying fallback defaults when needed.
 *
 * @param error - Unknown thrown value.
 * @param fallback - Optional fallback fields used when inference is ambiguous.
 * @returns Normalized worker error.
 */
export function asWorkerError(error: unknown, fallback: WorkerErrorFallback = {}): WorkerError {
  if (error instanceof WorkerError) {
    return error;
  }

  if (isWorkerProblem(error)) {
    return workerError({
      code: error.code,
      title: error.title,
      detail: error.detail,
      category: error.category,
      retryable: error.retryable,
      fatal: error.fatal,
      context: error.context,
      issues: error.issues,
      cause: error.cause,
      type: error.type,
    });
  }

  return workerError({
    code: inferCode(error, fallback),
    title: inferTitle(error, fallback),
    detail: inferDetail(error, fallback),
    category: inferCategory(error, fallback),
    retryable: inferRetryability(error, fallback),
    fatal: inferFatal(error, fallback),
    context: fallback.context,
    issues: error instanceof ZodError ? (fallback.issues ?? formatZodIssues(error)) : fallback.issues,
    cause: error instanceof Error ? getErrorCause(error) : undefined,
  });
}

/**
 * Serializes unknown errors into worker problem-details payload.
 *
 * @param error - Unknown thrown value.
 * @param instance - Optional instance path/context identifier.
 * @returns Structured worker problem details.
 */
export function serializeWorkerError(error: unknown, instance?: string): WorkerProblemDetails {
  return asWorkerError(error).toProblem(instance);
}
