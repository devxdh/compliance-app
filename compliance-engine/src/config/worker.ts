import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { assertIdentifier } from "../db/identifiers";
import { asWorkerError, fail } from "../errors";

const KEY_LENGTH = 32;

const mutationRuleSchema = z.enum(["HMAC", "STATIC_MASK", "NULLIFY"]);

export type MutationRule = z.infer<typeof mutationRuleSchema>;
export type RootPiiColumns = Record<string, MutationRule>;

const rootPiiColumnsSchema = z
  .record(z.string().min(1), mutationRuleSchema)
  .superRefine((value, ctx) => {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "graph.root_pii_columns must contain at least one column mapping.",
      });
      return;
    }

    for (const [column] of entries) {
      try {
        assertIdentifier(column, "graph root pii column");
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Invalid graph root pii column.",
        });
      }
    }
  });

const satelliteTargetSchema = z
  .object({
    table: z.string().min(1),
    lookup_column: z.string().min(1),
    action: z.enum(["redact", "hard_delete"]),
    masking_rules: z.record(z.string().min(1), mutationRuleSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      assertIdentifier(value.table, "satellite table name");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid satellite table name.",
        path: ["table"],
      });
    }

    try {
      assertIdentifier(value.lookup_column, "satellite lookup column");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid satellite lookup column.",
        path: ["lookup_column"],
      });
    }

    if (value.action === "redact" && (!value.masking_rules || Object.keys(value.masking_rules).length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "satellite target masking_rules is required for redact actions.",
        path: ["masking_rules"],
      });
      return;
    }

    if (!value.masking_rules) {
      return;
    }

    for (const column of Object.keys(value.masking_rules)) {
      try {
        assertIdentifier(column, "satellite masking rule column");
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Invalid satellite masking rule column.",
          path: ["masking_rules", column],
        });
      }
    }
  });

export type SatelliteTarget = z.infer<typeof satelliteTargetSchema>;

const workerYamlSchema = z
  .object({
    version: z.string().min(1),
    database: z
      .object({
        app_schema: z.string().min(1),
        engine_schema: z.string().min(1),
        replica_db_url: z.string().min(1).optional(),
      })
      .strict(),
    compliance_policy: z
      .object({
        retention_years: z.number().int().min(1),
        notice_window_hours: z.number().int().min(1),
      })
      .strict(),
    graph: z
      .object({
        root_table: z.string().min(1),
        root_id_column: z.string().min(1),
        max_depth: z.number().int().min(1).max(32),
        root_pii_columns: rootPiiColumnsSchema,
      })
      .strict(),
    satellite_targets: z.array(satelliteTargetSchema).min(1),
    outbox: z
      .object({
        batch_size: z.number().int().min(1),
        lease_seconds: z.number().int().min(1),
        max_attempts: z.number().int().min(1),
        base_backoff_ms: z.number().int().min(1).default(1000),
      })
      .strict(),
    security: z
      .object({
        notification_lease_seconds: z.number().int().min(1).default(120),
        master_key_env: z.string().min(1),
        hmac_key_env: z.string().min(1),
      })
      .strict(),
    integrity: z
      .object({
        expected_schema_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      assertIdentifier(value.database.app_schema, "application schema name");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid application schema name.",
        path: ["database", "app_schema"],
      });
    }

    try {
      assertIdentifier(value.database.engine_schema, "engine schema name");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid engine schema name.",
        path: ["database", "engine_schema"],
      });
    }

    try {
      assertIdentifier(value.graph.root_table, "graph root table");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid graph root table.",
        path: ["graph", "root_table"],
      });
    }

    try {
      assertIdentifier(value.graph.root_id_column, "graph root id column");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid graph root id column.",
        path: ["graph", "root_id_column"],
      });
    }
  });

type WorkerYamlConfig = z.infer<typeof workerYamlSchema>;

export interface WorkerConfig extends WorkerYamlConfig {
  masterKey: Uint8Array;
  hmacKey: Uint8Array;
}

function decodeKey(rawValue: string, envName: string): Uint8Array {
  const value = rawValue.trim();
  if (value.length === 0) {
    fail({
      code: "DPDP_SECRET_ENV_MISSING",
      title: "Required secret is missing",
      detail: `${envName} is required.`,
      category: "configuration",
      retryable: false,
      fatal: true,
      context: { envName },
    });
  }

  const normalizedHex = value.startsWith("hex:") ? value.slice(4) : value;
  if (/^[0-9a-fA-F]+$/.test(normalizedHex) && normalizedHex.length === KEY_LENGTH * 2) {
    return new Uint8Array(Buffer.from(normalizedHex, "hex"));
  }

  const normalizedBase64 = value.startsWith("base64:") ? value.slice(7) : value;
  const decoded = Buffer.from(normalizedBase64, "base64");
  if (decoded.length === KEY_LENGTH) {
    return new Uint8Array(decoded);
  }

  fail({
    code: "DPDP_SECRET_ENV_INVALID",
    title: "Invalid secret format",
    detail: `${envName} must decode to exactly ${KEY_LENGTH} bytes. Supported formats: 64-char hex or base64.`,
    category: "configuration",
    retryable: false,
    fatal: true,
    context: { envName },
  });
}

function normalizeWorkerYaml(config: WorkerYamlConfig): WorkerYamlConfig {
  return {
    ...config,
    database: {
      ...config.database,
      app_schema: assertIdentifier(config.database.app_schema, "application schema name"),
      engine_schema: assertIdentifier(config.database.engine_schema, "engine schema name"),
      replica_db_url: config.database.replica_db_url?.trim() || undefined,
    },
    graph: {
      ...config.graph,
      root_table: assertIdentifier(config.graph.root_table, "graph root table"),
      root_id_column: assertIdentifier(config.graph.root_id_column, "graph root id column"),
      root_pii_columns: Object.fromEntries(
        Object.entries(config.graph.root_pii_columns).map(([column, rule]) => [
          assertIdentifier(column, "graph root pii column"),
          rule,
        ])
      ),
    },
    satellite_targets: config.satellite_targets.map((target) => ({
      ...target,
      table: assertIdentifier(target.table, "satellite table name"),
      lookup_column: assertIdentifier(target.lookup_column, "satellite lookup column"),
      masking_rules: target.masking_rules
        ? Object.fromEntries(
            Object.entries(target.masking_rules).map(([column, rule]) => [
              assertIdentifier(column, "satellite masking rule column"),
              rule,
            ])
          )
        : undefined,
    })),
  };
}

/**
 * Reads `compliance.worker.yml`, validates it strictly, and resolves runtime cryptographic secrets.
 */
export function readWorkerConfig(
  env: Record<string, string | undefined> = process.env,
  configPath: string | URL = new URL("../../compliance.worker.yml", import.meta.url)
): WorkerConfig {
  const yamlText = readFileSync(configPath, "utf8");
  let parsedYaml: unknown;
  try {
    parsedYaml = yaml.load(yamlText);
  } catch (error) {
    throw asWorkerError(error, {
      code: "DPDP_CONFIG_YAML_INVALID",
      title: "Invalid worker YAML",
      detail: `Failed to parse ${String(configPath)} as YAML.`,
      category: "configuration",
      retryable: false,
      fatal: true,
      context: { configPath: String(configPath) },
    });
  }

  let parsedConfig: WorkerYamlConfig;
  try {
    parsedConfig = normalizeWorkerYaml(workerYamlSchema.parse(parsedYaml));
  } catch (error) {
    throw asWorkerError(error, {
      code: "DPDP_CONFIG_SCHEMA_INVALID",
      title: "Invalid worker configuration",
      category: "configuration",
      retryable: false,
      fatal: true,
      context: { configPath: String(configPath) },
    });
  }

  const masterKey = decodeKey(env[parsedConfig.security.master_key_env] ?? "", parsedConfig.security.master_key_env);
  const hmacKeyEnvValue = env[parsedConfig.security.hmac_key_env] ?? env[parsedConfig.security.master_key_env] ?? "";
  const hmacKey = decodeKey(hmacKeyEnvValue, parsedConfig.security.hmac_key_env);

  return {
    ...parsedConfig,
    masterKey,
    hmacKey,
  };
}
