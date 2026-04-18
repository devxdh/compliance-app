import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readWorkerConfig } from "../src/config/worker";

const masterKeyHex = "42".repeat(32);
const hmacKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x24)).toString("base64");

async function writeYaml(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "worker-config-"));
  const path = join(directory, "compliance.worker.yml");
  await writeFile(path, contents, "utf8");
  return path;
}

async function removeYaml(path: string) {
  await rm(path, { force: true });
  await rm(dirname(path), { recursive: true, force: true });
}

describe("Worker configuration", () => {
  const pathsToDelete: string[] = [];

  afterEach(async () => {
    for (const path of pathsToDelete.splice(0, pathsToDelete.length)) {
      await removeYaml(path);
    }
  });

  it("parses strict YAML config with strongly typed graph and satellite definitions", async () => {
    const path = await writeYaml(`
version: "1.0"
database:
  app_schema: tenant_app
  engine_schema: tenant_engine
  replica_db_url: postgres://replica:replica@replica-host:5432/postgres
compliance_policy:
  retention_years: 7
  notice_window_hours: 72
graph:
  root_table: users
  root_id_column: id
  max_depth: 32
  root_pii_columns:
    email: HMAC
    full_name: STATIC_MASK
satellite_targets:
  - table: marketing_leads
    lookup_column: email
    action: redact
    masking_rules:
      email: HMAC
  - table: audit_logs
    lookup_column: user_identifier
    action: hard_delete
outbox:
  batch_size: 20
  lease_seconds: 90
  max_attempts: 12
  base_backoff_ms: 1500
security:
  notification_lease_seconds: 180
  master_key_env: DPDP_MASTER_KEY
  hmac_key_env: DPDP_HMAC_KEY
integrity:
  expected_schema_hash: "${"1".repeat(64)}"
`);
    pathsToDelete.push(path);

    const config = readWorkerConfig(
      {
        DPDP_MASTER_KEY: masterKeyHex,
        DPDP_HMAC_KEY: `base64:${hmacKeyBase64}`,
      },
      path
    );

    expect(config.database.app_schema).toBe("tenant_app");
    expect(config.database.engine_schema).toBe("tenant_engine");
    expect(config.database.replica_db_url).toBe("postgres://replica:replica@replica-host:5432/postgres");
    expect(config.compliance_policy.retention_years).toBe(7);
    expect(config.compliance_policy.notice_window_hours).toBe(72);
    expect(config.graph.root_table).toBe("users");
    expect(config.graph.root_id_column).toBe("id");
    expect(config.graph.root_pii_columns).toEqual({
      email: "HMAC",
      full_name: "STATIC_MASK",
    });
    expect(config.satellite_targets).toHaveLength(2);
    expect(config.outbox.batch_size).toBe(20);
    expect(config.security.notification_lease_seconds).toBe(180);
    expect(Buffer.from(config.masterKey).toString("hex")).toBe(masterKeyHex);
    expect(Buffer.from(config.hmacKey).toString("base64")).toBe(hmacKeyBase64);
  });

  it("fails closed when required compliance fields are null", async () => {
    const path = await writeYaml(`
version: "1.0"
database:
  app_schema: tenant_app
  engine_schema: tenant_engine
compliance_policy:
  retention_years: null
  notice_window_hours: 48
graph:
  root_table: users
  root_id_column: id
  max_depth: 32
  root_pii_columns:
    email: HMAC
satellite_targets:
  - table: marketing_leads
    lookup_column: email
    action: redact
    masking_rules:
      email: HMAC
outbox:
  batch_size: 10
  lease_seconds: 60
  max_attempts: 10
  base_backoff_ms: 1000
security:
  notification_lease_seconds: 120
  master_key_env: DPDP_MASTER_KEY
  hmac_key_env: DPDP_HMAC_KEY
integrity:
  expected_schema_hash: "${"1".repeat(64)}"
`);
    pathsToDelete.push(path);

    expect(() =>
      readWorkerConfig(
        {
          DPDP_MASTER_KEY: masterKeyHex,
          DPDP_HMAC_KEY: `base64:${hmacKeyBase64}`,
        },
        path
      )
    ).toThrow(/retention_years/i);
  });

  it("rejects malicious identifier injection in root_table", async () => {
    const path = await writeYaml(`
version: "1.0"
database:
  app_schema: tenant_app
  engine_schema: tenant_engine
compliance_policy:
  retention_years: 5
  notice_window_hours: 48
graph:
  root_table: "users; DROP TABLE clients;--"
  root_id_column: id
  max_depth: 32
  root_pii_columns:
    email: HMAC
satellite_targets:
  - table: marketing_leads
    lookup_column: email
    action: redact
    masking_rules:
      email: HMAC
outbox:
  batch_size: 10
  lease_seconds: 60
  max_attempts: 10
  base_backoff_ms: 1000
security:
  notification_lease_seconds: 120
  master_key_env: DPDP_MASTER_KEY
  hmac_key_env: DPDP_HMAC_KEY
integrity:
  expected_schema_hash: "${"1".repeat(64)}"
`);
    pathsToDelete.push(path);

    expect(() =>
      readWorkerConfig(
        {
          DPDP_MASTER_KEY: masterKeyHex,
          DPDP_HMAC_KEY: `base64:${hmacKeyBase64}`,
        },
        path
      )
    ).toThrow(/invalid graph root table/i);
  });
});
