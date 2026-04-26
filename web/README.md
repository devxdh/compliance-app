# Avantii Web Dashboard

Next.js App Router dashboard for operating the Avantii Control Plane.

## Runtime

```bash
bun install
bun run web:typecheck
bun run web:build
bun run web:dev
```

## Architecture

The web app is a Backend-for-Frontend (BFF):

- Auth.js protects `/dashboard/*`.
- The browser receives only dashboard HTML, session cookies, and public assets.
- Control Plane admin calls are made from server components, server actions, or route handlers.
- `ADMIN_API_TOKEN` is never exposed to client components.
- If the token or API URL is missing, dashboard pages render a configuration-required state instead of fake rows.

## Environment

| Variable | Purpose |
| --- | --- |
| `AUTH_SECRET` | Auth.js session encryption secret. |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Optional Google OAuth provider credentials. |
| `AVANTII_ADMIN_EMAILS` | Comma-separated dashboard operator allowlist. |
| `ADMIN_API_TOKEN` | Server-side bearer token for `/api/v1/admin/*`. |
| `AVANTII_API_BASE_URL` | Server-side Control Plane base URL. |
| `NEXT_PUBLIC_AVANTII_API_BASE_URL` | Public Control Plane base URL used only for browser-safe certificate links. |

## Pages

- `/`: public landing page.
- `/login`: operator login/configuration state.
- `/dashboard`: usage and lifecycle overview.
- `/dashboard/erasure-requests`: metadata-only erasure request table.
- `/dashboard/erasure-requests/[id]`: request lifecycle, legal metadata, blob receipt summaries, and certificate download.
- `/dashboard/audit-ledger`: WORM ledger explorer with NDJSON export.
- `/dashboard/workers`: shadow-mode burn-in and worker status overview.
- `/dashboard/clients`: worker client registration, key rotation, and deactivation.
- `/dashboard/dead-letters`: failed task review and requeue.

## Testing

```bash
bun run web:test
```

The Playwright suite requires Chromium system dependencies on the host. If Chromium fails to start with missing shared libraries, install Playwright dependencies for the local OS before rerunning.
