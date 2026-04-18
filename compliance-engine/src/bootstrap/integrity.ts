import type postgres from "postgres";
import { detectSchemaDrift } from "../db/drift";
import { fail } from "../errors";

export async function assertSchemaIntegrity(
  sql: postgres.Sql,
  appSchema: string,
  expectedSchemaHash: string
): Promise<string> {
  const detectedSchemaHash = await detectSchemaDrift(sql, appSchema);

  if (detectedSchemaHash !== expectedSchemaHash) {
    fail({
      code: "DPDP_SCHEMA_DRIFT_DETECTED",
      title: "Schema drift detected",
      detail: `Schema drift detected for ${appSchema}. Expected ${expectedSchemaHash}, received ${detectedSchemaHash}. Refusing to start.`,
      category: "integrity",
      retryable: false,
      fatal: true,
      context: {
        appSchema,
        expectedSchemaHash,
        detectedSchemaHash,
      },
    });
  }

  return detectedSchemaHash;
}
