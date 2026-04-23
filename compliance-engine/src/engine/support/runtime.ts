import { assertIdentifier } from "../../db/identifiers";
import { fail } from "../../errors";
import type { WorkerSchemas, WorkerSecrets } from "../contracts";
import {
  DEFAULT_APP_SCHEMA,
  DEFAULT_ENGINE_SCHEMA,
  DEFAULT_GRAPH_MAX_DEPTH,
  DEFAULT_NOTICE_WINDOW_HOURS,
  DEFAULT_RETENTION_YEARS,
} from "./types";

/**
 * Resolves and validates application and engine schema identifiers.
 *
 * @param input - Optional schema overrides from operation options.
 * @returns Canonical schema names safe for dynamic identifier interpolation.
 * @throws {WorkerError} When any schema name fails identifier validation.
 */
export function resolveSchemas(input: WorkerSchemas = {}) {
  return {
    appSchema: assertIdentifier(
      input.appSchema ?? DEFAULT_APP_SCHEMA,
      "application schema name"
    ),
    engineSchema: assertIdentifier(
      input.engineSchema ?? DEFAULT_ENGINE_SCHEMA,
      "engine schema name"
    ),
  };
}

/**
 * Normalizes notice-window configuration while enforcing the legal minimum of one hour.
 *
 * @param hours - Optional notice window in hours.
 * @returns Validated notice window value.
 * @throws {WorkerError} When `hours` is non-integer or less than 1.
 */
export function resolveNoticeWindowHours(hours?: number): number {
  if (hours === undefined) {
    return DEFAULT_NOTICE_WINDOW_HOURS;
  }

  if (!Number.isInteger(hours) || hours < 1) {
    fail({
      code: "DPDP_NOTICE_WINDOW_INVALID",
      title: "Invalid notice window",
      detail: "noticeWindowHours must be an integer greater than 0.",
      category: "validation",
      retryable: false,
    });
  }

  return hours;
}

/**
 * Normalizes retention years with strict non-negative validation.
 *
 * @param years - Optional retention duration in years.
 * @returns Validated retention duration.
 * @throws {WorkerError} When `years` is non-integer or negative.
 */
export function resolveRetentionYears(years?: number): number {
  if (years === undefined) {
    return DEFAULT_RETENTION_YEARS;
  }

  if (!Number.isInteger(years) || years < 0) {
    fail({
      code: "DPDP_RETENTION_YEARS_INVALID",
      title: "Invalid retention period",
      detail: "retentionYears must be an integer greater than or equal to 0.",
      category: "validation",
      retryable: false,
    });
  }

  return years;
}

/**
 * Normalizes dependency graph traversal depth and enforces a positive integer bound.
 *
 * @param depth - Optional graph traversal depth.
 * @returns Validated depth used by graph discovery.
 * @throws {WorkerError} When `depth` is non-integer or less than 1.
 */
export function resolveGraphMaxDepth(depth?: number): number {
  if (depth === undefined) {
    return DEFAULT_GRAPH_MAX_DEPTH;
  }

  if (!Number.isInteger(depth) || depth < 1) {
    fail({
      code: "DPDP_GRAPH_MAX_DEPTH_INVALID",
      title: "Invalid graph max depth",
      detail: "graphMaxDepth must be an integer greater than 0.",
      category: "validation",
      retryable: false,
    });
  }

  return depth;
}

/**
 * Validates worker cryptographic material before any vaulting operation begins.
 *
 * `hmacKey` falls back to `kek` when not provided, preserving deterministic pseudonymization.
 *
 * @param secrets - Worker key material loaded from config or env.
 * @returns Normalized key pair safe for downstream crypto helpers.
 * @throws {WorkerError} When KEK length is not 32 bytes or HMAC key is empty.
 */
export function assertWorkerSecrets(
  secrets: WorkerSecrets
): { kek: Uint8Array; hmacKey: Uint8Array } {
  if (secrets.kek.length !== 32) {
    fail({
      code: "DPDP_KEK_INVALID_LENGTH",
      title: "Invalid KEK length",
      detail: `Invalid KEK length. Expected 32 bytes, got ${secrets.kek.length}.`,
      category: "configuration",
      retryable: false,
      fatal: true,
    });
  }

  const hmacKey = secrets.hmacKey ?? secrets.kek;
  if (hmacKey.length === 0) {
    fail({
      code: "DPDP_HMAC_KEY_EMPTY",
      title: "Invalid HMAC key",
      detail: "HMAC key must not be empty.",
      category: "configuration",
      retryable: false,
      fatal: true,
    });
  }

  return {
    kek: secrets.kek,
    hmacKey,
  };
}
