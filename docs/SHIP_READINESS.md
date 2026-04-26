# Ship Readiness Checklist

Last updated: 2026-04-26

This checklist is for an India-first founder preparing Avantii for paid DPDP/PMLA pilots and then production sales. It is not legal advice; use it to structure counsel, CISO, and procurement reviews.

## Current Ship Level

The codebase is ready for controlled technical pilots with friendly design partners where:

- The client understands this is pre-certification software.
- The deployment is isolated to a test or non-critical production slice.
- Retention YAML is reviewed by the client's DPO/legal team.
- Webhooks, mailer, KMS, and object-store credentials are scoped and reversible.
- You run local E2E plus client-specific shadow-mode burn-in before live mutation.

It is not yet ready for broad self-serve paid production without the items below.

## Must-Have Before Paid Production

### Legal And GRC

- Engage Indian privacy counsel to review DPDP Act/Rules interpretation, PMLA/RBI retention templates, contracts, limitation of liability, and processor/fiduciary role language.
- Produce a Data Processing Agreement, Master Services Agreement, security exhibit, subprocessors list, privacy notice, and incident response terms.
- Define who owns legal retention YAML changes, who approves them, and how policy migrations are handled when a rule changes.
- Create a DPO attestation workflow outside raw YAML editing: approval, versioning, signature, rollback, and audit export.
- Prepare DPIA-style deployment documentation for client CISOs.

### Security

- Complete external VAPT for API, worker, web, Docker images, Kubernetes manifests, and webhook SSRF controls.
- Add SAST, dependency scanning, secret scanning, container scanning, and SBOM generation in CI.
- Add WAF/API gateway rules in front of the Control Plane.
- Move admin auth from a single bearer token to organization users, roles, MFA, and audit logs.
- Add production-grade worker/API auth rotation runbooks and per-client scoped tokens.
- Have a third party review crypto design and implementation.

### Reliability

- Run multi-worker contention tests against realistic client schemas and large satellite tables.
- Run backup/restore drills for Control Plane Postgres.
- Run disaster recovery drills for lost worker, duplicate task replay, schema drift, KMS outage, webhook outage, S3 partial purge, and mailer outage.
- Define SLOs and alerts for task lag, DLQ growth, outbox lag, certificate creation failure, API 5xx rate, webhook failure rate, and schema drift.
- Add staging and production environments with separate databases, keys, DNS, and dashboards.

### Product And Billing

- Integrate a billing provider before self-serve launch. For an India-first SaaS, evaluate Razorpay/PayU/Cashfree for INR invoicing and Stripe for international cards where available.
- Add plans, usage metering, invoices, GST handling, refunds, and admin billing screens.
- Add tenant/organization management in the web app: members, roles, invitations, API keys, worker registration, and audit logs.
- Add onboarding flow for config generation, schema scan, shadow-mode burn-in, and go-live approval.
- Add downloadable Proof of Erasure PDFs from the dashboard with clear legal disclaimers and signature verification instructions.

## Should-Have Before Enterprise Sales

- SAML/OIDC SSO, SCIM, RBAC, and audit trails for every dashboard operator action.
- Immutable audit export to client-owned storage such as S3 Object Lock, GCS Bucket Lock, or WORM-compatible archival.
- Signed worker config release process with CI-generated manifests and DPO approval gates.
- Optional true long-polling or broker-backed task fanout for very large installations.
- Dedicated tenant isolation model for Control Plane data, including per-tenant backup/restore and data residency posture.
- Formal runbooks for key rotation, certificate key rollover, client offboarding, emergency pause, replay, and legal hold.

## Founder Sequence

1. Close legal documents and DPDP/PMLA retention templates with counsel.
2. Convert admin bearer-token auth into real organization/user/RBAC auth.
3. Add billing, GST invoicing, and usage-to-invoice reconciliation.
4. Run a full VAPT and fix findings.
5. Ship two design-partner pilots in shadow mode only.
6. Move one pilot to live mutation after 100 successful shadow tasks and signed DPO attestation.
7. Add self-serve onboarding only after support, incident response, and billing are stable.
