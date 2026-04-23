# Backend API

This app hosts the API your real React frontend can call.

## Start

```bash
yarn --cwd apps/backend start
```

## Render

This repository includes a root `render.yaml` blueprint for deploying the backend as a Docker-based Render web service.

Why Docker instead of PM2:

- Render already manages process restarts and logs.
- Docker makes the backend runtime reproducible.
- The backend can install and run from its own package boundary without relying on root workspace tooling.

Required environment variables:

- `ANCHOR_PROVIDER_URL`
- `ARCIUM_CLUSTER_OFFSET`
- `LOWKIE_PROGRAM_ID`
- `RELAYER_KEYPAIR_PATH`
- `LOWKIE_API_AUTH_TOKEN`
- `LOWKIE_ALLOWED_ORIGINS`

Recommended production values:

- `LOWKIE_REQUIRE_API_AUTH=true`
- `LOWKIE_OPERATOR_COMPACT_REGISTRY=false`
- `LOWKIE_RPC_HTTP_TIMEOUT_MS=30000`
- `LOWKIE_MAX_REQUEST_BODY_BYTES=262144`

The server already respects Render's `HOST` and `PORT` environment variables.

## Endpoints

- `GET /api/health`
- `GET /api/relayer/health`
- `GET /api/denominations`
- `GET /api/pool/status`
- `POST /api/build-deposits`
- `POST /api/submit-deposits`
- `POST /api/send`
- `GET /api/recoverable`
- `POST /api/recover`
- `POST /api/relay`