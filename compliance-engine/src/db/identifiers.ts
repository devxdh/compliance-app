import { fail } from "../errors";

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function assertIdentifier(name: string, label: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    fail({
      code: "DPDP_IDENTIFIER_INVALID",
      title: "Invalid identifier",
      detail: `Invalid ${label}: "${name}". Only letters, numbers, and underscores are allowed.`,
      category: "validation",
      retryable: false,
      context: { label },
    });
  }

  return name;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

export function quoteQualifiedIdentifier(schema: string, table: string): string {
  return `${quoteIdentifier(assertIdentifier(schema, "schema name"))}.${quoteIdentifier(assertIdentifier(table, "table name"))}`;
}
