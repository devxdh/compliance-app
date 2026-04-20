# Deployment Assets

## Local stack
- `docker-compose.yml` brings up Postgres, API, worker, Prometheus, Alertmanager, Grafana, and a local mail/webhook sink.
- `bun run local:e2e` renders the local worker config, boots the stack, submits an erasure request, waits for a certificate, verifies mail delivery, and tears the stack down.

## Kubernetes
- `deploy/k8s/base` contains the least-privilege baseline manifests.
- The manifests assume an external Postgres service and Vault Secrets Store CSI for secret delivery.
- Replace placeholder images before deployment.

## Secret handling
- The code supports both direct env vars and `_FILE` companions.
- For Kubernetes, prefer CSI-mounted files over plain env values.

