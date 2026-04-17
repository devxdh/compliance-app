import { readFile } from "node:fs/promises";

const EXPECTED_SCHEMA_HASH_REGEX = /^\s*expected_schema_hash:\s*"?([0-9a-fA-F]{64})"?\s*$/m;

export interface WorkerManifest {
  expectedSchemaHash: string;
}

export async function readWorkerManifest(
  manifestPath: string | URL = new URL("../compliance.worker.yml", import.meta.url)
): Promise<WorkerManifest> {
  const manifestText = await readFile(manifestPath, "utf8");
  const expectedSchemaHashMatch = manifestText.match(EXPECTED_SCHEMA_HASH_REGEX);

  if (!expectedSchemaHashMatch) {
    throw new Error("compliance.worker.yml must define integrity.expected_schema_hash as a 64-character SHA-256 hex digest.");
  }

  return {
    expectedSchemaHash: expectedSchemaHashMatch[1]!.toLowerCase(),
  };
}
