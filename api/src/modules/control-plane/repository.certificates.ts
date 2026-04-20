import type {
  CertificateRow,
  InsertCertificateInput,
  RepositoryContext,
} from "./repository.types";

/**
 * Inserts a signed Certificate of Erasure idempotently.
 *
 * @param context - Repository SQL context.
 * @param input - Persisted certificate payload and signature envelope.
 * @returns `true` when inserted, `false` when certificate already exists.
 */
export async function insertCertificate(
  context: RepositoryContext,
  input: InsertCertificateInput
): Promise<boolean> {
  const rows = await context.sql<{ request_id: string }[]>`
    INSERT INTO ${context.sql(context.schema)}.certificates (
      request_id,
      subject_opaque_id,
      method,
      legal_framework,
      shredded_at,
      payload,
      signature_base64,
      public_key_spki_base64,
      key_id,
      algorithm
    ) VALUES (
      ${input.requestId},
      ${input.subjectOpaqueId},
      ${input.method},
      ${input.legalFramework},
      ${input.shreddedAt},
      ${context.sql.json(input.payload as import("postgres").JSONValue)},
      ${input.signatureBase64},
      ${input.publicKeySpkiBase64},
      ${input.keyId},
      ${input.algorithm}
    )
    ON CONFLICT (request_id) DO NOTHING
    RETURNING request_id
  `;

  return rows.length > 0;
}

/**
 * Fetches minted certificate by request id.
 *
 * @param context - Repository SQL context.
 * @param requestId - Erasure request UUID.
 * @returns Certificate row or `null`.
 */
export async function getCertificateByRequestId(
  context: RepositoryContext,
  requestId: string
): Promise<CertificateRow | null> {
  const [certificate] = await context.sql<CertificateRow[]>`
    SELECT *
    FROM ${context.sql(context.schema)}.certificates
    WHERE request_id = ${requestId}
  `;

  return certificate ?? null;
}
