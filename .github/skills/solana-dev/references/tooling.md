# Tooling

## Current Repo Baseline

- Anchor Rust stack: `anchor-lang` `0.32.x`
- Arcium Rust integration: `arcium-anchor` `0.9.5`
- TypeScript client: `@coral-xyz/anchor` `0.32.x`
- Solana client library: `@solana/web3.js` `1.x`
- Test harness: `ts-mocha`

## Best-Practice Guidance For This Repo

- Keep dependency changes small and intentional.
- If a task only needs local fixes, do not broaden it into a toolchain migration.
- Use non-interactive commands where possible and prefer deterministic output.
- Typecheck before running broader tests.

## When A Migration Is Reasonable

Only propose broader ecosystem migrations when the user explicitly asks for them, for example:

- `@solana/kit` for a new standalone client package or app
- framework-kit for a production wallet UI rewrite
- LiteSVM or Mollusk for fast unit-test coverage
- Surfpool for realistic local integration environments
- Codama for generated clients and IDL-first package boundaries
