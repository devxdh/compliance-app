import { readFileSync } from "node:fs";

/**
 * Resolves a runtime secret from an environment variable or its mounted-file companion.
 *
 * If `FOO_FILE` is present, the worker reads the secret from that path. This supports
 * Kubernetes secret volumes, Vault agent injection, and CSI-mounted secret providers
 * without changing the YAML contract that names logical secret identifiers.
 *
 * @param env - Raw environment map.
 * @param envName - Logical environment variable name declared in YAML.
 * @returns Resolved secret value or an empty string when no source is configured.
 */
export function readRuntimeSecret(
  env: Record<string, string | undefined>,
  envName: string
): string {
  const directValue = env[envName];
  if (directValue && directValue.trim().length > 0) {
    return directValue.trim();
  }

  const filePath = env[`${envName}_FILE`];
  if (!filePath || filePath.trim().length === 0) {
    return "";
  }

  return readFileSync(filePath, "utf8").trim();
}
