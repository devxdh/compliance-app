const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates SQL identifiers used in dynamic schema/table references.
 */
export function assertIdentifier(name: string, label: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Invalid ${label}: "${name}". Only letters, numbers, and underscores are allowed.`);
  }

  return name;
}

