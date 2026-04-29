# Lowkie SDK

TypeScript client for the Lowkie backend API.

Use this package from React apps, Next.js apps, server-side Node services, or any JavaScript runtime that can call your deployed Lowkie backend.

## What It Wraps

`@lowkie/sdk` is an HTTP client for the Lowkie backend. It does not talk to Solana RPC directly and it does not replace wallet-adapter signing. Instead, it wraps the backend endpoints that:

- report backend and pool health
- expose supported denominations
- apply the backend's denomination-splitting policy
- build deposit transactions for client-side signing
- submit signed deposits for MPC processing and relay execution
- recover stuck transfers by withdrawal or refund

## Install

```bash
npm install @lowkie/sdk
```

```bash
pnpm add @lowkie/sdk
```

```bash
yarn add @lowkie/sdk
```

```bash
bun add @lowkie/sdk
```

## Runtime Requirements

- The SDK needs a reachable Lowkie backend base URL.
- The SDK uses `fetch` by default.
- In browsers and modern runtimes, no extra transport setup is needed.
- In older Node.js environments without global `fetch`, pass `fetchImpl` explicitly.

## Quick Start

```ts
import { LowkieSdkClient, SUPPORTED_DENOMINATIONS } from "@lowkie/sdk";

const client = new LowkieSdkClient({
  baseUrl: "https://your-lowkie-backend.onrender.com",
});

const health = await client.health();
const pools = await client.poolStatus();

console.log(health.ok, health.network);
console.log(SUPPORTED_DENOMINATIONS);
console.log(pools.pools);
```

## Authentication

Lowkie backends can protect write endpoints with bearer-token auth.

- Public read endpoints are typically safe to expose without auth.
- Transfer, recovery, and relay endpoints may require `Authorization: Bearer <token>`.
- If your backend requires auth, pass `authToken` when creating the client.

```ts
const client = new LowkieSdkClient({
  baseUrl: "https://your-lowkie-backend.onrender.com",
  authToken: process.env.LOWKIE_API_TOKEN,
});
```

## Public Methods

These methods are typically safe for dashboards, status pages, and setup flows:

- `health()` returns backend health, network, program ID, and readiness details.
- `relayerHealth()` returns relayer execution status.
- `denominations()` returns the currently supported fixed pool denominations.
- `poolStatus()` returns pool PDA status and initialization state.

```ts
const health = await client.health();
const relayer = await client.relayerHealth();
const denominations = await client.denominations();
const pools = await client.poolStatus();
```

## Production Transfer Flow

The production integration path is client-signed deposits.

In this model:

- the app provides sender, recipient, and total amount to the backend
- the backend decides how the amount is split across supported denominations
- the backend builds one or more deposit transactions
- the user signs those transactions with their own wallet
- the backend submits the signed deposits, waits for MPC processing, and drives relayer execution

Use this flow in browser apps where the user signs with their own Solana wallet.

Step 1: ask the backend to build deposit transactions.

```ts
const built = await client.buildDeposits({
  sender: walletPublicKey.toBase58(),
  recipient: "RecipientWalletAddress",
  amountSol: 1.5,
  delayMs: 15_000,
});

console.log(built.recoveryId);
console.log(built.transactionsBase64.length); // one tx per backend-selected note
```

Step 2: sign the returned base64 transactions in the client.

```ts
import { VersionedTransaction } from "@solana/web3.js";

const signedTransactionsBase64 = await Promise.all(
  built.transactionsBase64.map(async (encoded) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
    const signed = await wallet.signTransaction(tx);
    return Buffer.from(signed.serialize()).toString("base64");
  }),
);
```

Step 3: submit the signed transactions back to the backend.

```ts
const result = await client.submitDeposits({
  recoveryId: built.recoveryId,
  signedTransactionsBase64,
});

console.log(result.depositReceipts);
console.log(result.withdrawals);
```

Notes:

- The client does not compute denomination splits.
- The client does not construct protocol instructions directly.
- The relayer remains a backend/operator concern, not a frontend wallet concern.

## Recovery

If deposits succeeded but later processing failed, Lowkie returns a `recoveryId` that lets you retry withdrawal or refund.

List pending recoveries:

```ts
const recoverable = await client.listRecoverable();
console.log(recoverable.transfers);
```

Retry withdrawal:

```ts
await client.recover({
  recoveryId: "lowkie-17120000000-abcd",
  mode: "withdraw",
});
```

Refund back to the sender path:

```ts
await client.recover({
  recoveryId: "lowkie-17120000000-abcd",
  mode: "refund",
});
```

## Direct Relay Calls

`relay()` exists for advanced operator-managed flows where you already have relay payload material. Normal frontend integrations should not call this directly; they should use the `buildDeposits()` plus `submitDeposits()` flow.

## Error Handling

The SDK throws `LowkieApiError` for non-2xx responses.

```ts
import { LowkieApiError } from "@lowkie/sdk";

try {
  await client.buildDeposits({
    sender: walletPublicKey.toBase58(),
    recipient: "RecipientWalletAddress",
    amountSol: 1.5,
  });
} catch (error) {
  if (error instanceof LowkieApiError) {
    console.error(error.status);
    console.error(error.message);
    console.error(error.payload);
  }
}
```

## Convenience Helpers

If you prefer a minimal constructor, use `createLowkieClient()`:

```ts
import { createLowkieClient } from "@lowkie/sdk";

const client = createLowkieClient(
  "https://your-lowkie-backend.onrender.com",
  process.env.LOWKIE_API_TOKEN,
);
```

## Exported Constants

`SUPPORTED_DENOMINATIONS` exposes the currently supported fixed pool denominations:

- `10.0 SOL`
- `5.0 SOL`
- `2.0 SOL`
- `1.0 SOL`
- `0.5 SOL`
- `0.1 SOL`
- `0.05 SOL`
- `0.01 SOL`

## Maintainer Validation

From the repo root:

```bash
npm --prefix packages/lowkie-sdk run typecheck
npm --prefix packages/lowkie-sdk run build
cd packages/lowkie-sdk && npm pack --dry-run
```

## Publish

1. Bump the version in `packages/lowkie-sdk/package.json`.
2. Re-run the maintainer validation commands.
3. Authenticate with npm: `npm login`.
4. Publish from the package directory.

```bash
cd packages/lowkie-sdk
npm publish --access public
```

`prepublishOnly` runs the package build automatically before publish.
