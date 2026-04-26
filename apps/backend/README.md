# Backend API

This app hosts the API your real React frontend can call.

## Start

```bash
yarn --cwd apps/backend start
```

## Deployment

This repository includes a root deployment blueprint for running the backend as a Docker-based web service.

Required environment variables:

- `ANCHOR_PROVIDER_URL`
- `ARCIUM_CLUSTER_OFFSET`
- `LOWKIE_PROGRAM_ID`
- one wallet source for the backend signer (`ANCHOR_WALLET_JSON`, `ANCHOR_WALLET_BASE58`, or `ANCHOR_WALLET`)
- one wallet source for the sender (`SENDER_WALLET_JSON`, `SENDER_WALLET_BASE58`, or `SENDER_WALLET`)
- one wallet source for the relayer (`RELAYER_KEYPAIR_JSON`, `RELAYER_KEYPAIR_BASE58`, or `RELAYER_KEYPAIR_PATH`)
- `LOWKIE_API_AUTH_TOKEN`
- `LOWKIE_ALLOWED_ORIGINS`

Deployment notes:

- Prefer `*_JSON` env vars on managed hosts instead of file paths.
- `*_BASE58` env vars are also supported if you store secret keys that way.
- `RELAYER_KEYPAIR_PATH` remains supported for local and operator-managed hosts.
- If you use the JSON variants, store the full 64-byte Solana secret-key array as the secret value.

Recommended production values:

- `LOWKIE_REQUIRE_API_AUTH=true`
- `LOWKIE_OPERATOR_COMPACT_REGISTRY=false`
- `LOWKIE_RPC_HTTP_TIMEOUT_MS=30000`
- `LOWKIE_MAX_REQUEST_BODY_BYTES=262144`

The server already respects standard `HOST` and `PORT` environment variables.

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
