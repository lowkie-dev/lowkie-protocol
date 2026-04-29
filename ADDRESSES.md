# Lowkie Devnet Address Inventory

This file records the configured and derived address set for the current Lowkie deployment.

- Network: devnet
- RPC: https://api.devnet.solana.com
- Arcium cluster offset: 456
- Lowkie program ID: 8BQ1SwL7udKofSCAGgYXcRX7uMCvt33k6nbSEbXBkYNF
- Arcium program ID: Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ
- Status note: this inventory is authoritative from repo config and PDA derivation. A live existence audit was not completed because the public devnet RPC returned 429 rate limits.

## Core Deployment

| Item | Address |
| --- | --- |
| Lowkie program | 8BQ1SwL7udKofSCAGgYXcRX7uMCvt33k6nbSEbXBkYNF |
| Arcium program | Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ |
| Protocol config PDA | 6zoTs1GUuEjjVmt535AQTX8HPjeAXTidSdaVae4UpDk6 |
| MXE account | 7fwJePHv2aCtdmS1nHUBqEPFUPgPxDRZbBmSadtKFEqv |
| Cluster account | DzaQCyfybroycrNqE5Gk7LhSbWD2qfCics6qptBFbr95 |
| Mempool account | Ex7BD8o8PK1y2eXDd38Jgujj93uHygrZeWXDeGAHmHtN |
| Executing pool | 4mcrgNZzJwwKrE3wXMHfepT8htSBmGqBzDYPJijWooog |
| Arcium fee pool | G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC |
| Arcium clock account | 7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot |

## Computation Definitions

| Computation | Address |
| --- | --- |
| init_pool_balance | CFa9zjZBDGdgDKfZr38pSCEMhBm9fakpYeBE68MBD6NQ |
| deposit_to_pool | EuHMKC7V7Ma7ij7dhYrtb4V1Kmwuobq4JSRnBrzbFbgi |
| withdraw_from_pool | 7HMaZsNM22TJ7ctaPGGvy32WtKwfbGWNjJq4bpdSaatj |
| compact_registry | 5kzm3DnAUuEeZNHyR7Wa9zwj3nYPRKJWvRiDwRctTh8Q |

Note: the current environment is configured for offchain circuit sources, so the computation definitions are the relevant fixed on-chain addresses here. If you switch to onchain circuit registration, raw circuit accounts will also need rent-funded creation.

## Pool Addresses

| Denomination | Pool PDA | Vault PDA | Nullifier Registry PDA |
| --- | --- | --- | --- |
| 10 SOL | Cab7KSmpfTpqP5Nd7dzDu73qsEfdgSmRoSYrwCDH1oc | HVdyZ9e9pw9VrwGZt6KwoKGhy6MJEtaEw9XTmepyWPT5 | ETAANxFTCSvk58UdihYryDLp5nHu1UA1MbxbYPrDPrVm |
| 5 SOL | 6oTzQv68zQGLuQEL4u3fiAR5LDJJSX2kFH6ADKwLbrK5 | 7xzCF4JunRKiGcQ5g79uvBenN6s3mH48M16o5G2Gow7i | GPouWrUwY16ZGJXqzXvT1bayxtstToCmwDTyLgoxWGRK |
| 2 SOL | 2auBcDFLxeymrZtZDTiLKeUfqV3D6TSfnzZxEbKX7xKA | 7Qvo25tMFztC9zPeWARkFyXm1GDVWFGYEJgKvyVuVip3 | 2EGyjqL65BJqRSYM4uT6SXHmbiK2GX4Y6pQwSrCHvkGX |
| 1 SOL | 9rvKJy6vgVMXwk6Lp2Pb5F3jccRqCNMU3hhAX7fxJ1pJ | aj8uitRmh2SPWQikQNq2ERLuTETrCVgs4qyNExXD1AR | 8ASNViVEG1JLdKcVDXrm8FPqaXD3JA3qvbZCTHwLSE6 |
| 0.5 SOL | 3CG5LFPb3cbjmLZX2rGffJY9F8npDg3BdC7Z4bVjGUJY | BRTH1V2vksRgKUjUVYZmojtQ2NZaePu9tUDthJy8GJAu | 2kujpApJ8vaXfetxftYLa4KJ7MNtimbY5ZZ8nYtLXM6L |
| 0.1 SOL | A1ry3wCe5YpQcvEbHjXU5Kf8KoP5NvXoDT9AymMbEZN | A8xXj5NMn4bTDnsBn86havhe1HA7PLakPXfZxjXKUefQ | A884cVcY3TWnSAJUw7d6M13HvXKkkESkpHNk7aL7Bfqw |
| 0.05 SOL | 9RXa8xSutrzwvnSqVitocEAJqomJ5pPCRPddnZzVW8X9 | HGFhLYJRdx7RexWwM545Try7THQBqXmEcmQcqZkqLdBX | A7D7S68ui7AbYTZacR6aakT71ef8R1sVDfUtbXkt2Eb8 |
| 0.01 SOL | 24eSUPFLPLkk6Bctntt95VxUzPdNH5xZQPpXAHnqkHGG | CkdDaTL63RC773cEjLCGGpvCP9bcrVgx5VRFHSbMqaMC | 2PToax3Nh6dnf19MpsBw5qy1SMaQZUgA3LnZCgQvTtrb |

## Offchain Circuit Sources

| Circuit | Source |
| --- | --- |
| init_pool_balance | https://w3s.link/ipfs/bafkreie3tqitbkibov27we2jzisawe2rx26wtzwcltycwva2jh27a3yszm |
| deposit_to_pool | https://w3s.link/ipfs/bafybeifcm7helxr6gjvvf2y66ww5gkscgqcyotguzi7jtrqse2rakay5im |
| withdraw_from_pool | https://w3s.link/ipfs/bafybeibad2ntac4qu7xd2v7g2a6mihpsqg4vok7stsek7ce2wry7mbckay |
| compact_registry | https://w3s.link/ipfs/bafkreiciqo4ttpj3nhqq6o4afn2wifuij3oaugylhqdp56f6xxzwjsawxy |

## What Needs Funding

### Wallets That Need SOL

| Wallet role | Why it needs SOL |
| --- | --- |
| Bootstrap/admin payer | Pays transaction fees and one-time rent for protocol config, computation definitions, and pool initialization accounts. |
| Sender | Pays deposit transaction fees and rent for runtime note and nullifier accounts created during deposit. |
| Relayer | Pays withdraw and compaction transaction fees. Also pays one-time rent for the shared signer PDA if it is first created from a relayer flow. |

### Fixed Accounts That Need Rent Once At Creation

| Account type | Who funds it | Notes |
| --- | --- | --- |
| Protocol config PDA | Bootstrap/admin payer | Created with init and payer = payer. |
| Computation definition accounts | Bootstrap/admin payer | Registered during bootstrap. |
| Pool state PDAs | Bootstrap/admin payer | One per supported denomination. |
| Vault PDAs | Bootstrap/admin payer | Account data rent is one-time; deposited SOL inside the vault is protocol liquidity, not gas. |
| Nullifier registry PDAs | Bootstrap/admin payer | One per supported denomination. |
| Shared signer PDA | First caller that triggers init_if_needed | Can be created by bootstrap payer, sender, or relayer depending on first flow. |

### Runtime Accounts That Need Rent Per Deposit

| Account type | Who funds it | Notes |
| --- | --- | --- |
| Note account PDA | Sender | Created in deposit with payer = sender. |
| Nullifier record PDA | Sender | Created or initialized in deposit with payer = sender. |

## What Does Not Need Manual Funding

- The deployed Lowkie program ID does not need to be topped up for normal use after deployment. Program deployment and upgrades are paid by the upgrade authority wallet, not by sending SOL to the program address.
- Arcium infra accounts in this inventory, including the MXE account, cluster, mempool, executing pool, fee pool, and clock account, are treated by this repo as external Arcium-owned infrastructure. I found no Lowkie-side top-up path for them.
- The recipient address does not need SOL before withdrawal. The relayer pays the withdrawal transaction fee so the receiver can be gasless.
- Existing protocol config, pool, vault, and nullifier registry PDAs do not need ongoing gas funding once created and kept rent exempt.

## Operational Notes

- The shared signer PDA is a fixed Lowkie PDA used by Arcium flows. Its existence and funding behavior are documented above, but its exact address is not listed here because the derivation is exposed only through the Rust macro path in the current dependency surface, not the TypeScript helper layer used for the rest of this inventory.
- If the shared signer PDA does not exist yet, the first instruction path that touches it must have enough SOL to make it rent exempt.
- If the repo is switched from offchain circuit mode to onchain circuit mode, additional rent will be needed for raw circuit accounts.
- Vault balances are not a rent or gas concern. They hold actual deposited lamports and should be monitored as protocol funds, not fee reserves.

## Evidence In Repo

- Deployment config: [Anchor.toml](Anchor.toml), [.env](.env), [apps/backend/.env](apps/backend/.env)
- Address derivation: [apps/backend/src/core/arciumAccounts.ts](apps/backend/src/core/arciumAccounts.ts), [apps/backend/src/core/constants.ts](apps/backend/src/core/constants.ts), [apps/backend/src/core/readiness.ts](apps/backend/src/core/readiness.ts)
- Bootstrap payer flows: [apps/backend/scripts/bootstrap-program.ts](apps/backend/scripts/bootstrap-program.ts)
- On-chain account init and payer rules: [programs/lowkie_pool/src/lib.rs](programs/lowkie_pool/src/lib.rs)
- Relayer-paid withdrawal model: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md)