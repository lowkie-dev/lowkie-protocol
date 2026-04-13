# Testing

## Current Default Strategy

This repository currently relies on TypeScript integration tests driven by `ts-mocha`, Anchor, and an Arcium-enabled local environment.

Default commands:

- `yarn -s typecheck`
- `arcium build`
- `ANCHOR_PROVIDER_URL='http://127.0.0.1:8899' ANCHOR_WALLET="$HOME/.config/solana/id.json" ARCIUM_CLUSTER_OFFSET=0 yarn -s test`

## How To Extend Tests

- When changing instruction semantics, add or update integration cases in `tests/lowkie.ts`.
- Prefer targeted negative-path tests for:
  - recipient mismatch
  - secret mismatch
  - pool denomination mismatch
  - double-spend rejection
  - registry-full behavior
- When changing only TypeScript utility logic, validate with typecheck and the smallest targeted runtime test path available.

## Repo-Specific Best Practice

- Do not migrate this repo to LiteSVM, Mollusk, or Surfpool as part of an unrelated feature or fix. Those may be worthwhile modernization options, but they are a separate project.
- Preserve existing end-to-end coverage around Arcium callbacks and relayer flow. Those are the protocol-critical paths.
