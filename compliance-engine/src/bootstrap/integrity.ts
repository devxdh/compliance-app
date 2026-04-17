import type postgres from "postgres";
import { readWorkerManifest } from "../config/manifest";
import { detectSchemaDrift } from "../db/drift";

export async function assertSchemaIntegrity(
  sql: postgres.Sql,
  appSchema: string,
  manifestPath?: string | URL
): Promise<string> {
  const { expectedSchemaHash } = await readWorkerManifest(manifestPath);
  const detectedSchemaHash = await detectSchemaDrift(sql, appSchema);

  if (detectedSchemaHash !== expectedSchemaHash) {
    throw new Error(
      `Schema drift detected for ${appSchema}. Expected ${expectedSchemaHash}, received ${detectedSchemaHash}. Refusing to start.`
    );
  }

  return detectedSchemaHash;
}
