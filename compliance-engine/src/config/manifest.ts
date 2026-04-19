import { readFile } from "node:fs/promises";
import { fail } from "../errors";

const EXPECTED_SCHEMA_HASH_REGEX = /^\s*expected_schema_hash:\s*"?([0-9a-fA-F]{64})"?\s*$/m;

export interface WorkerManifest {
  expectedSchemaHash: string;
}

/**
 * Reads `compliance.worker.yml` and extracts the expected schema fingerprint used at boot.
 *
 * @param manifestPath - Path to worker YAML manifest.
 * @returns Manifest subset currently required during integrity bootstrap.
 * @throws {WorkerError} When `integrity.expected_schema_hash` is missing or malformed.
 */
export async function readWorkerManifest(
  manifestPath: string | URL = new URL("../compliance.worker.yml", import.meta.url)
): Promise<WorkerManifest> {
  const manifestText = await readFile(manifestPath, "utf8");
  const expectedSchemaHashMatch = manifestText.match(EXPECTED_SCHEMA_HASH_REGEX);

  if (!expectedSchemaHashMatch) {
    fail({
      code: "DPDP_CONFIG_SCHEMA_HASH_MISSING",
      title: "Missing schema hash",
      detail: "compliance.worker.yml must define integrity.expected_schema_hash as a 64-character SHA-256 hex digest.",
      category: "configuration",
      retryable: false,
      fatal: true,
    });
  }

  return {
    expectedSchemaHash: expectedSchemaHashMatch[1]!.toLowerCase(),
  };
}
