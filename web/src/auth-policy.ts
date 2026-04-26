/**
 * Parses the dashboard operator allowlist from environment variables.
 *
 * `AVANTII_ADMIN_EMAILS` is intentionally fail-closed: when OAuth is configured
 * but this list is empty, sign-in is denied instead of granting every valid
 * Google account access to the Control Plane UI.
 *
 * @returns Normalized operator email set.
 */
export function getAdminEmailAllowlist(): ReadonlySet<string> {
  const raw = process.env.AVANTII_ADMIN_EMAILS ?? process.env.ADMIN_EMAIL_ALLOWLIST ?? "";
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Checks whether an authenticated OAuth identity may access the dashboard.
 *
 * @param email - Email returned by the OAuth provider.
 * @returns `true` only when the email is explicitly allowlisted.
 */
export function isAllowedDashboardOperator(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }

  return getAdminEmailAllowlist().has(email.toLowerCase());
}
