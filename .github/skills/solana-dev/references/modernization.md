# Modernization

This reference captures how to apply broader Solana Foundation best practices without forcing a premature rewrite.

## Safe Modernization Order

1. Keep the on-chain program stable first.
   Protocol correctness and privacy invariants come before framework churn.

2. Separate public SDK concerns from operator scripts.
   If the project grows beyond a hackathon/demo shape, split reusable client APIs from one-off orchestration scripts.

3. Upgrade test layers intentionally.
   Consider LiteSVM or Mollusk for fast unit-style testing only when you want new test classes, not while fixing unrelated logic.

4. Upgrade frontend stack only if the demo becomes a product surface.
   At that point, framework-kit and more modern wallet UX patterns become worth evaluating.

5. Consider generated clients only when program interfaces stabilize.
   Codama-style generation is useful once the public program surface is mature enough to support an SDK boundary.

## What Not To Do

- Do not mix a stack migration with a protocol bugfix.
- Do not introduce new Solana abstractions that obscure current PDA, signer, or ciphertext flows.
- Do not move generated, localnet, or secret-bearing files into committed source paths.
