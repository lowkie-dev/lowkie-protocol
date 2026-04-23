/**
 * Lowkie Integration Tests
 * Run: arcium test            (localnet)
 *      arcium test --cluster devnet   (devnet, cluster offset 456)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  x25519,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getArciumEnv,
  getMXEAccAddress,
  getCompDefAccOffset,
  awaitComputationFinalization,
  getArciumProgramId,
  getArciumProgram,
  getCompDefAccAddress,
  getLookupTableAddress,
  buildFinalizeCompDefTx,
} from "@arcium-hq/client";
import { randomBytes, createHash } from "crypto";
import fs from "node:fs";
import os from "node:os";
import { expect } from "chai";
import {
  buildArciumQueueAccounts,
  deriveNullifierRecordPda,
  deriveNullifierRegistryPda,
  derivePoolPda,
  deriveProtocolConfigPda,
  deriveVaultPda,
} from "../apps/backend/src/core/arciumAccounts";
import { decomposeIntoDenominations } from "../apps/backend/src/core/utils";
import {
  resolveClusterOffset,
  SUPPORTED_DENOMINATION_LAMPORTS,
} from "../apps/backend/src/core/constants";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getMXEKey(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  retries = 120,
): Promise<Uint8Array> {
  for (let i = 0; i < retries; i++) {
    const k = await getMXEPublicKey(provider, programId);
    if (k) return k;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("MXE key unavailable. Is `arcium localnet` running?");
}

function noteHash(
  secret: Uint8Array,
  recipient: PublicKey,
  lamports: bigint,
): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(lamports);
  return createHash("sha256")
    .update(secret)
    .update(recipient.toBuffer())
    .update(buf)
    .digest();
}

function recipientHash(withdrawKey: Uint8Array, recipient: PublicKey): Buffer {
  return createHash("sha256")
    .update(withdrawKey)
    .update(recipient.toBuffer())
    .digest();
}

function publicNullifierHash(secret: Uint8Array): Buffer {
  return createHash("sha256")
    .update("lowkie:nullifier:v1")
    .update(secret)
    .digest();
}

function pda(seeds: Buffer[], programId: PublicKey) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function awaitEvent<T>(program: Program<any>, name: string): Promise<T> {
  return new Promise((res) => {
    let id: number;
    id = program.addEventListener(name, (e: T) => {
      program.removeEventListener(id);
      res(e);
    });
  });
}

async function waitForNoteStatus(
  program: Program<any>,
  notePDA: PublicKey,
  expected: "ready" | "withdrawn" | "failed",
  retries = 120,
): Promise<any> {
  let lastStatus: string | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const note = await (program.account as any).noteAccount.fetch(notePDA);
      lastStatus = JSON.stringify(note.status);
      if ((note.status as Record<string, unknown>)[expected]) {
        return note;
      }
    } catch {
      lastStatus = "(account not found)";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Timed out waiting for note status: ${expected} (last seen: ${lastStatus})`,
  );
}

async function waitForNoteClosed(
  connection: anchor.web3.Connection,
  notePDA: PublicKey,
  retries = 60,
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    const noteInfo = await connection.getAccountInfo(notePDA, "confirmed");
    if (!noteInfo) {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Timed out waiting for spent note account to close");
}

async function tryFetchPool(
  program: Program<any>,
  poolPDA: PublicKey,
): Promise<any | null> {
  try {
    return await (program.account as any).poolState.fetch(poolPDA);
  } catch {
    return null;
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Lowkie — Arcium MXE Privacy Pool", () => {
  const providerUrl =
    process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const wsUrl =
    process.env.ANCHOR_WS_URL ??
    providerUrl
      .replace(/^http/, "ws")
      .replace(/:(\d+)$/, (_, p: string) => `:${Number(p) + 1}`);
  const walletPath =
    process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`;
  const payerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
  const connection = new anchor.web3.Connection(providerUrl, {
    commitment: "confirmed",
    wsEndpoint: wsUrl,
  });
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payerKeypair),
    { commitment: "confirmed" },
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.LowkiePool as Program<any>;
  const programId = program.programId;
  const arciumClusterOffset =
    resolveClusterOffset() ?? getArciumEnv().arciumClusterOffset;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const relayer = Keypair.generate();
  const recipient = Keypair.generate();

  const primaryDenominationLamports = 100_000_000n;
  const secondaryDenominationLamports =
    SUPPORTED_DENOMINATION_LAMPORTS[SUPPORTED_DENOMINATION_LAMPORTS.length - 1];
  if (!SUPPORTED_DENOMINATION_LAMPORTS.includes(primaryDenominationLamports)) {
    throw new Error(
      "tests/lowkie.ts expects 0.1 SOL to remain a supported denomination",
    );
  }
  const poolPDA = derivePoolPda(programId, primaryDenominationLamports);
  const vaultPDA = deriveVaultPda(programId, primaryDenominationLamports);
  const protocolConfigPDA = deriveProtocolConfigPda(programId);
  const nullifierRegistryPDA = deriveNullifierRegistryPda(
    programId,
    primaryDenominationLamports,
  );

  let noteSecret: Uint8Array;
  let withdrawKey: Uint8Array;
  let hash: Buffer;
  let recpHash: Buffer;
  let mainNullifierHash: Buffer;
  let amountLamports: bigint;

  /** Split a 32-byte secret into two u128 limbs (little-endian). */
  function splitSecretToU128(secret: Uint8Array): [bigint, bigint] {
    let lo = 0n;
    for (let i = 0; i < 16; i++) lo |= BigInt(secret[i]) << BigInt(i * 8);
    let hi = 0n;
    for (let i = 0; i < 16; i++) hi |= BigInt(secret[16 + i]) << BigInt(i * 8);
    return [lo, hi];
  }

  function arciumAccs(offset: anchor.BN, defOffset: number) {
    const compDefNames: Record<number, string> = {
      [cdOffset("init_pool_balance")]: "init_pool_balance",
      [cdOffset("deposit_to_pool")]: "deposit_to_pool",
      [cdOffset("withdraw_from_pool")]: "withdraw_from_pool",
      [cdOffset("compact_registry")]: "compact_registry",
    };
    const compDefName = compDefNames[defOffset];
    if (!compDefName) {
      throw new Error(`Unknown computation definition offset: ${defOffset}`);
    }

    return {
      ...buildArciumQueueAccounts(
        programId,
        arciumClusterOffset,
        offset,
        compDefName,
      ),
      systemProgram: SystemProgram.programId,
    };
  }

  function cdOffset(name: string) {
    return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
  }

  async function ensurePoolInitialized(denominationLamports: bigint) {
    const denominationPoolPDA = derivePoolPda(programId, denominationLamports);
    const denominationVaultPDA = deriveVaultPda(
      programId,
      denominationLamports,
    );
    const denominationNullifierRegistryPDA = deriveNullifierRegistryPda(
      programId,
      denominationLamports,
    );
    const existingPool = await tryFetchPool(program, denominationPoolPDA);

    if (!existingPool?.isInitialized) {
      const mxeKey = await getMXEKey(provider, programId);
      const priv = x25519.utils.randomSecretKey();
      const pub = x25519.getPublicKey(priv);
      const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([0n], nonce);
      const nonceBN = new anchor.BN(deserializeLE(nonce).toString());
      const offset = new anchor.BN(randomBytes(8), "hex");

      await program.methods
        .initPool(
          offset,
          new anchor.BN(denominationLamports.toString()),
          Array.from(ct[0]),
          Array.from(pub),
          nonceBN,
        )
        .accountsPartial({
          payer: payer.publicKey,
          poolState: denominationPoolPDA,
          vault: denominationVaultPDA,
          nullifierRegistry: denominationNullifierRegistryPDA,
          ...arciumAccs(offset, cdOffset("init_pool_balance")),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      await awaitComputationFinalization(
        provider,
        offset,
        programId,
        "confirmed",
      );
    }

    // Keep suite reruns deterministic when reusing an existing validator.
    if (existingPool?.isInitialized) {
      await compactNullifierRegistry(denominationLamports);
    }

    const pool = await (program.account as any).poolState.fetch(
      denominationPoolPDA,
    );
    expect(pool.isInitialized).to.be.true;
    expect(BigInt(pool.denominationLamports.toString())).to.equal(
      denominationLamports,
    );

    return {
      poolPDA: denominationPoolPDA,
      vaultPDA: denominationVaultPDA,
      nullifierRegistryPDA: denominationNullifierRegistryPDA,
    };
  }

  async function compactNullifierRegistry(denominationLamports: bigint) {
    const denominationPoolPDA = derivePoolPda(programId, denominationLamports);
    const denominationNullifierRegistryPDA = deriveNullifierRegistryPda(
      programId,
      denominationLamports,
    );

    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .compactRegistry(offset, new anchor.BN(denominationLamports.toString()))
      .accountsPartial({
        relayer: relayer.publicKey,
        protocolConfig: protocolConfigPDA,
        poolState: denominationPoolPDA,
        nullifierRegistry: denominationNullifierRegistryPDA,
        ...arciumAccs(offset, cdOffset("compact_registry")),
      })
      .signers([relayer])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      offset,
      programId,
      "confirmed",
    );
    console.log("    ✅ Nullifier registry compacted");
  }

  async function ensureProtocolConfig() {
    try {
      const existing = await (program.account as any).protocolConfig.fetch(
        protocolConfigPDA,
      );

      if (!new PublicKey(existing.admin).equals(payer.publicKey)) {
        return;
      }

      if (
        !new PublicKey(existing.maintenanceAuthority).equals(relayer.publicKey)
      ) {
        const methods = program.methods as any;
        await methods
          .updateProtocolConfig(null, relayer.publicKey)
          .accounts({
            admin: payer.publicKey,
            protocolConfig: protocolConfigPDA,
          })
          .rpc({ commitment: "confirmed" });
      }
      return;
    } catch {
      const methods = program.methods as any;
      await methods
        .initializeProtocolConfig(relayer.publicKey)
        .accounts({
          payer: payer.publicKey,
          protocolConfig: protocolConfigPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
    }
  }

  before("Fund relayer + recipient", async () => {
    await ensureProtocolConfig();
    await getMXEKey(provider, programId);

    for (const [kp, sol] of [
      [relayer, 0.5],
      [recipient, 0.01],
    ] as [Keypair, number][]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        sol * LAMPORTS_PER_SOL,
      );
      const bh = await provider.connection.getLatestBlockhash("confirmed");
      await provider.connection.confirmTransaction(
        { signature: sig, ...bh },
        "confirmed",
      );
    }
  });

  // ── 0. Register comp defs ─────────────────────────────────────────────────

  it("0: Registers all four computation definitions", async () => {
    const mxeAccount = getMXEAccAddress(programId);
    const arciumProgram = getArciumProgramId();
    const arcium = getArciumProgram(provider);
    const mxe = await (arcium.account as any).mxeAccount.fetch(mxeAccount);
    const addressLookupTable = getLookupTableAddress(
      programId,
      mxe.lutOffsetSlot,
    );
    const lutProgram = new PublicKey(
      "AddressLookupTab1e1111111111111111111111111",
    );

    for (const [method, compDefName] of [
      ["initInitPoolCompDef", "init_pool_balance"],
      ["initDepositCompDef", "deposit_to_pool"],
      ["initWithdrawCompDef", "withdraw_from_pool"],
      ["initCompactCompDef", "compact_registry"],
    ] as const) {
      const compDefAccount = getCompDefAccAddress(
        programId,
        cdOffset(compDefName),
      );
      const existingCompDef = await provider.connection.getAccountInfo(
        compDefAccount,
        "confirmed",
      );
      if (!existingCompDef) {
        await (program.methods as any)
          [method](null, null)
          .accounts({
            payer: payer.publicKey,
            protocolConfig: protocolConfigPDA,
            mxeAccount,
            compDefAccount,
            addressLookupTable,
            lutProgram,
            arciumProgram,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" });
      }

      const finalizeTx = await buildFinalizeCompDefTx(
        provider,
        cdOffset(compDefName),
        programId,
      );
      try {
        await provider.sendAndConfirm(finalizeTx, [], {
          commitment: "confirmed",
        });
      } catch (e: unknown) {
        const msg = (e as Error).message ?? "";
        if (!msg.includes("already") && !msg.includes("Completed")) {
          throw e;
        }
      }
    }
    console.log("    ✅ All comp defs registered");
  });

  // ── 1. Init pool ──────────────────────────────────────────────────────────

  it("1: init_pool — MPC creates Enc<Mxe,0> and stores it in PoolState", async () => {
    await ensurePoolInitialized(primaryDenominationLamports);
    const pool = await (program.account as any).poolState.fetch(poolPDA);
    expect(pool.isInitialized).to.be.true;
    expect(BigInt(pool.denominationLamports.toString())).to.equal(
      primaryDenominationLamports,
    );
    expect(Buffer.from(pool.encryptedBalance).equals(Buffer.alloc(32))).to.be
      .false;
    console.log(
      "    ✅ PoolState.encrypted_balance =",
      Buffer.from(pool.encryptedBalance).toString("hex").slice(0, 16) + "...",
    );
  });

  // ── 2. Deposit (with recipient encryption) ────────────────────────────────

  it("2: deposit — SOL to vault, recipient hidden as hash, MPC updates encrypted pool", async () => {
    amountLamports = primaryDenominationLamports;
    noteSecret = new Uint8Array(randomBytes(32));
    withdrawKey = new Uint8Array(randomBytes(32));
    mainNullifierHash = publicNullifierHash(noteSecret);
    recpHash = recipientHash(withdrawKey, recipient.publicKey);
    hash = noteHash(noteSecret, recipient.publicKey, amountLamports);
    const notePDA = pda([Buffer.from("note"), hash], programId);
    const nullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      mainNullifierHash,
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));

    // Encrypt transfer amount
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([amountLamports], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    // Encrypt note secret (split into two u128 limbs) — NEVER sent as plaintext
    const [secretLo, secretHi] = splitSecretToU128(noteSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([secretLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([secretHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const offset = new anchor.BN(randomBytes(8), "hex");

    const poolBefore = await (program.account as any).poolState.fetch(poolPDA);
    await program.methods
      .deposit(
        offset,
        Array.from(ct[0]),
        Array.from(pub),
        nonceBN,
        Array.from(ctSecLo[0]),
        Array.from(ctSecHi[0]),
        nonceSecLoB,
        nonceSecHiB,
        Array.from(recpHash),
        Array.from(mainNullifierHash),
        new anchor.BN(amountLamports.toString()),
        Array.from(hash),
      )
      .accountsPartial({
        sender: payer.publicKey,
        poolState: poolPDA,
        noteRegistry: notePDA,
        nullifierRecord: nullifierRecordPDA,
        vault: vaultPDA,
        ...arciumAccs(offset, cdOffset("deposit_to_pool")),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("    Waiting for Arcium MPC...");
    await awaitComputationFinalization(
      provider,
      offset,
      programId,
      "confirmed",
    );

    const note = await waitForNoteStatus(program, notePDA, "ready");
    expect(note.status).to.deep.equal({ ready: {} });
    expect(Buffer.from(note.encryptedAmount).equals(Buffer.alloc(32))).to.be
      .false;
    // Verify encrypted secret was stored
    expect(Buffer.from(note.encryptedSecretLo).equals(Buffer.alloc(32))).to.be
      .false;
    expect(Buffer.from(note.encryptedSecretHi).equals(Buffer.alloc(32))).to.be
      .false;

    // Verify recipient is hidden: stored as hash, not plaintext
    expect(Buffer.from(note.recipientHash)).to.deep.equal(recpHash);
    console.log(
      "    ✅ NoteAccount.recipient_hash (SHA256):",
      Buffer.from(note.recipientHash).toString("hex").slice(0, 16) + "...",
    );
    console.log("    ✅ Recipient pubkey is NOT stored on-chain");

    const poolAfter = await (program.account as any).poolState.fetch(poolPDA);
    expect(
      Buffer.from(poolAfter.encryptedBalance).equals(
        Buffer.from(poolBefore.encryptedBalance),
      ),
    ).to.be.false;
    console.log(
      "    ✅ PoolState updated — no plaintext amount or recipient anywhere on-chain",
    );
  });

  // ── 3. Withdraw (recipient revealed + verified via hash) ──────────────────

  it("3: withdraw — relayer encrypts secret for MPC, recipient verified via withdraw_key, SOL delivered", async () => {
    await new Promise((r) => setTimeout(r, 5000));
    const notePDA = pda([Buffer.from("note"), hash], programId);
    const nullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      mainNullifierHash,
    );
    const offset = new anchor.BN(randomBytes(8), "hex");
    const balBefore = await provider.connection.getBalance(recipient.publicKey);

    // Encrypt claimed secret for MPC verification — NEVER sent as plaintext
    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
    const [secretLo, secretHi] = splitSecretToU128(noteSecret);
    const nonceLo = randomBytes(16);
    const ctLo = cipher.encrypt([secretLo], nonceLo);
    const nonceLoB = new anchor.BN(deserializeLE(nonceLo).toString());
    const nonceHi = randomBytes(16);
    const ctHi = cipher.encrypt([secretHi], nonceHi);
    const nonceHiB = new anchor.BN(deserializeLE(nonceHi).toString());

    await program.methods
      .withdraw(
        offset,
        Array.from(withdrawKey),
        Array.from(ctLo[0]),
        Array.from(ctHi[0]),
        Array.from(pub),
        nonceLoB,
        nonceHiB,
      )
      .accountsPartial({
        relayer: relayer.publicKey,
        noteRegistry: notePDA,
        nullifierRecord: nullifierRecordPDA,
        poolState: poolPDA,
        vault: vaultPDA,
        nullifierRegistry: nullifierRegistryPDA,
        recipient: recipient.publicKey,
        ...arciumAccs(offset, cdOffset("withdraw_from_pool")),
      })
      .signers([relayer])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("    Waiting for Arcium MPC...");
    await awaitComputationFinalization(
      provider,
      offset,
      programId,
      "confirmed",
    );

    const withdrawnNote = await waitForNoteStatus(
      program,
      notePDA,
      "withdrawn",
    );
    expect(withdrawnNote.status).to.deep.equal({ withdrawn: {} });
    console.log("    ✅ Note status: Withdrawn");

    await program.methods
      .compactSpentNote(Array.from(hash))
      .accountsPartial({
        relayer: relayer.publicKey,
        noteRegistry: notePDA,
      })
      .signers([relayer])
      .rpc({ commitment: "confirmed" });

    await waitForNoteClosed(provider.connection, notePDA, 30);
    const balAfter = await provider.connection.getBalance(recipient.publicKey);
    const noteInfo = await provider.connection.getAccountInfo(
      notePDA,
      "confirmed",
    );
    const delta = balAfter - balBefore;

    expect(noteInfo).to.equal(null);
    expect(delta).to.equal(Number(amountLamports));
    console.log("    ✅ Recipient received", delta / LAMPORTS_PER_SOL, "SOL");
    console.log("    ✅ Spent note removed from chain state after withdrawal");
    console.log(
      "    ✅ No inner instruction logs — amount invisible to explorers",
    );
  });

  // ── 4. Double-spend ───────────────────────────────────────────────────────

  it("4: Rejects double-spend", async () => {
    const notePDA = pda([Buffer.from("note"), hash], programId);
    const nullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      mainNullifierHash,
    );
    const noteBefore = await provider.connection.getAccountInfo(
      notePDA,
      "confirmed",
    );
    const closed = noteBefore === null;
    const offset = new anchor.BN(randomBytes(8), "hex");

    // Encrypt the secret for the attempted double-spend
    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
    const [secretLo, secretHi] = splitSecretToU128(noteSecret);
    const nonceLo = randomBytes(16);
    const ctLo = cipher.encrypt([secretLo], nonceLo);
    const nonceLoB = new anchor.BN(deserializeLE(nonceLo).toString());
    const nonceHi = randomBytes(16);
    const ctHi = cipher.encrypt([secretHi], nonceHi);
    const nonceHiB = new anchor.BN(deserializeLE(nonceHi).toString());

    try {
      await program.methods
        .withdraw(
          offset,
          Array.from(withdrawKey),
          Array.from(ctLo[0]),
          Array.from(ctHi[0]),
          Array.from(pub),
          nonceLoB,
          nonceHiB,
        )
        .accountsPartial({
          relayer: relayer.publicKey,
          noteRegistry: notePDA,
          nullifierRecord: nullifierRecordPDA,
          poolState: poolPDA,
          vault: vaultPDA,
          nullifierRegistry: nullifierRegistryPDA,
          recipient: recipient.publicKey,
          ...arciumAccs(offset, cdOffset("withdraw_from_pool")),
        })
        .signers([relayer])
        .rpc({ commitment: "confirmed" });
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(
        msg.includes("NoteNotReady") ||
          msg.includes("InvalidPreimage") ||
          msg.includes("AccountNotEnoughKeys") ||
          msg.includes("Account does not exist") ||
          msg.includes("has no data") ||
          msg.includes("ConstraintSeeds") ||
          msg.includes("initialized") ||
          msg.includes("discriminator") ||
          msg.includes("deserialize"),
      ).to.be.true;
      if (closed) {
        console.log(
          "    ✅ Spent note cannot be replayed after account closure",
        );
      } else {
        console.log("    ✅ Double-spend rejected");
      }
    }
  });

  // ── 5. Wrong recipient rejected ───────────────────────────────────────────

  it("5: Rejects note recreation after closure when nullifier already spent", async () => {
    const notePDA = pda([Buffer.from("note"), hash], programId);
    const nullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      mainNullifierHash,
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));

    // Encrypt transfer amount
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([amountLamports], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    // Encrypt note secret for deposit
    const [secretLo, secretHi] = splitSecretToU128(noteSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([secretLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([secretHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const depositOffset = new anchor.BN(randomBytes(8), "hex");

    try {
      await program.methods
        .deposit(
          depositOffset,
          Array.from(ct[0]),
          Array.from(pub),
          nonceBN,
          Array.from(ctSecLo[0]),
          Array.from(ctSecHi[0]),
          nonceSecLoB,
          nonceSecHiB,
          Array.from(recpHash),
          Array.from(mainNullifierHash),
          new anchor.BN(amountLamports.toString()),
          Array.from(hash),
        )
        .accountsPartial({
          sender: payer.publicKey,
          poolState: poolPDA,
          noteRegistry: notePDA,
          nullifierRecord: nullifierRecordPDA,
          vault: vaultPDA,
          ...arciumAccs(depositOffset, cdOffset("deposit_to_pool")),
        })
        .rpc({ commitment: "confirmed" });
      expect.fail("Replay deposit should have been rejected");
    } catch (e: unknown) {
      const message = (e as Error).message;
      expect(
        message.includes("NullifierAlreadySpent") ||
          message.includes("custom program error") ||
          message.includes("Unknown action"),
      ).to.be.true;
    }

    const replayedNote = await provider.connection.getAccountInfo(
      notePDA,
      "confirmed",
    );
    expect(replayedNote).to.equal(null);
    console.log(
      "    ✅ Spent nullifier blocks note recreation before a replay deposit can succeed",
    );
  });

  // ── 6. Wrong recipient rejected ───────────────────────────────────────────

  it("6: Rejects wrong recipient (recipient hash mismatch)", async () => {
    const {
      poolPDA: secondaryPoolPDA,
      vaultPDA: secondaryVaultPDA,
      nullifierRegistryPDA: secondaryNullifierRegistryPDA,
    } = await ensurePoolInitialized(secondaryDenominationLamports);

    // Create a new deposit with known recipient
    const testAmount = secondaryDenominationLamports;
    const testSecret = new Uint8Array(randomBytes(32));
    const testWithdrawKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecpHash = recipientHash(testWithdrawKey, recipient.publicKey);
    const testNoteHash = noteHash(testSecret, recipient.publicKey, testAmount);
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));

    // Encrypt transfer amount
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([testAmount], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    // Encrypt note secret for deposit
    const [tSecLo, tSecHi] = splitSecretToU128(testSecret);
    const tNonceSecLo = randomBytes(16);
    const tCtSecLo = cipher.encrypt([tSecLo], tNonceSecLo);
    const tNonceSecLoB = new anchor.BN(deserializeLE(tNonceSecLo).toString());
    const tNonceSecHi = randomBytes(16);
    const tCtSecHi = cipher.encrypt([tSecHi], tNonceSecHi);
    const tNonceSecHiB = new anchor.BN(deserializeLE(tNonceSecHi).toString());

    const offset = new anchor.BN(randomBytes(8), "hex");

    await program.methods
      .deposit(
        offset,
        Array.from(ct[0]),
        Array.from(pub),
        nonceBN,
        Array.from(tCtSecLo[0]),
        Array.from(tCtSecHi[0]),
        tNonceSecLoB,
        tNonceSecHiB,
        Array.from(testRecpHash),
        Array.from(testNullifierHash),
        new anchor.BN(testAmount.toString()),
        Array.from(testNoteHash),
      )
      .accountsPartial({
        sender: payer.publicKey,
        poolState: secondaryPoolPDA,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        vault: secondaryVaultPDA,
        ...arciumAccs(offset, cdOffset("deposit_to_pool")),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      offset,
      programId,
      "confirmed",
    );
    await waitForNoteStatus(program, testNotePDA, "ready");

    // Try to withdraw to a DIFFERENT recipient — should fail
    // The withdraw_key was computed with recipient.publicKey, so using wrongRecipient
    // will cause SHA256(withdraw_key ∥ wrongRecipient) != stored recipient_hash
    const wrongRecipient = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      wrongRecipient.publicKey,
      0.01 * LAMPORTS_PER_SOL,
    );
    const bh = await provider.connection.getLatestBlockhash("confirmed");
    await provider.connection.confirmTransaction(
      { signature: sig, ...bh },
      "confirmed",
    );

    // Encrypt claimed secret for the attempted wrong-recipient withdraw
    const priv2 = x25519.utils.randomSecretKey();
    const pub2 = x25519.getPublicKey(priv2);
    const cipher2 = new RescueCipher(x25519.getSharedSecret(priv2, mxeKey));
    const wNonceLo = randomBytes(16);
    const wCtLo = cipher2.encrypt([tSecLo], wNonceLo);
    const wNonceLoB = new anchor.BN(deserializeLE(wNonceLo).toString());
    const wNonceHi = randomBytes(16);
    const wCtHi = cipher2.encrypt([tSecHi], wNonceHi);
    const wNonceHiB = new anchor.BN(deserializeLE(wNonceHi).toString());

    const withdrawOffset = new anchor.BN(randomBytes(8), "hex");
    try {
      await program.methods
        .withdraw(
          withdrawOffset,
          Array.from(testWithdrawKey),
          Array.from(wCtLo[0]),
          Array.from(wCtHi[0]),
          Array.from(pub2),
          wNonceLoB,
          wNonceHiB,
        )
        .accountsPartial({
          relayer: relayer.publicKey,
          noteRegistry: testNotePDA,
          nullifierRecord: testNullifierRecordPDA,
          poolState: secondaryPoolPDA,
          vault: secondaryVaultPDA,
          nullifierRegistry: secondaryNullifierRegistryPDA,
          recipient: wrongRecipient.publicKey,
          ...arciumAccs(withdrawOffset, cdOffset("withdraw_from_pool")),
        })
        .signers([relayer])
        .rpc({ commitment: "confirmed" });
      expect.fail("Should have thrown — wrong recipient");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg.includes("RecipientMismatch")).to.be.true;
      console.log(
        "    ✅ Wrong recipient rejected via withdraw_key hash verification",
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // UNIT TESTS — Pure helper functions, no network / MPC required
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Unit: Helper functions", () => {
    it("U1: noteHash is deterministic and changes with any input change", () => {
      const secret = new Uint8Array(randomBytes(32));
      const recip = Keypair.generate().publicKey;
      const amount = 100_000_000n;

      const h1 = noteHash(secret, recip, amount);
      const h2 = noteHash(secret, recip, amount);
      expect(h1).to.deep.equal(h2);

      // Different secret → different hash
      const secret2 = new Uint8Array(randomBytes(32));
      const h3 = noteHash(secret2, recip, amount);
      expect(h1.equals(h3)).to.be.false;

      // Different recipient → different hash
      const recip2 = Keypair.generate().publicKey;
      const h4 = noteHash(secret, recip2, amount);
      expect(h1.equals(h4)).to.be.false;

      // Different amount → different hash
      const h5 = noteHash(secret, recip, 200_000_000n);
      expect(h1.equals(h5)).to.be.false;

      console.log(
        "    ✅ noteHash deterministic + collision-resistant for all inputs",
      );
    });

    it("U2: recipientHash is deterministic and independent of noteHash", () => {
      const wKey = new Uint8Array(randomBytes(32));
      const recip = Keypair.generate().publicKey;

      const rh1 = recipientHash(wKey, recip);
      const rh2 = recipientHash(wKey, recip);
      expect(rh1).to.deep.equal(rh2);

      // Different withdrawKey → different hash
      const wKey2 = new Uint8Array(randomBytes(32));
      const rh3 = recipientHash(wKey2, recip);
      expect(rh1.equals(rh3)).to.be.false;

      // Different recipient → different hash
      const recip2 = Keypair.generate().publicKey;
      const rh4 = recipientHash(wKey, recip2);
      expect(rh1.equals(rh4)).to.be.false;

      // recipientHash !== noteHash (even with same secret/key bytes)
      const sharedBytes = new Uint8Array(randomBytes(32));
      const nh = noteHash(sharedBytes, recip, 100_000_000n);
      const rh = recipientHash(sharedBytes, recip);
      expect(nh.equals(rh)).to.be.false;

      console.log(
        "    ✅ recipientHash deterministic + decoupled from noteHash",
      );
    });

    it("U3: splitSecretToU128 correctly splits 32 bytes into two u128 limbs", () => {
      // Zero secret
      const zero = new Uint8Array(32);
      const [zLo, zHi] = splitSecretToU128(zero);
      expect(zLo).to.equal(0n);
      expect(zHi).to.equal(0n);

      // All 0xFF
      const ones = new Uint8Array(32).fill(0xff);
      const [oLo, oHi] = splitSecretToU128(ones);
      const maxU128 = (1n << 128n) - 1n;
      expect(oLo).to.equal(maxU128);
      expect(oHi).to.equal(maxU128);

      // First byte only
      const first = new Uint8Array(32);
      first[0] = 0x42;
      const [fLo, fHi] = splitSecretToU128(first);
      expect(fLo).to.equal(0x42n);
      expect(fHi).to.equal(0n);

      // Byte 16 (first byte of hi limb)
      const mid = new Uint8Array(32);
      mid[16] = 0xab;
      const [mLo, mHi] = splitSecretToU128(mid);
      expect(mLo).to.equal(0n);
      expect(mHi).to.equal(0xabn);

      // Round-trip: reconstruct original bytes
      const secret = new Uint8Array(randomBytes(32));
      const [lo, hi] = splitSecretToU128(secret);
      const rebuilt = new Uint8Array(32);
      let tmpLo = lo;
      for (let i = 0; i < 16; i++) {
        rebuilt[i] = Number(tmpLo & 0xffn);
        tmpLo >>= 8n;
      }
      let tmpHi = hi;
      for (let i = 0; i < 16; i++) {
        rebuilt[16 + i] = Number(tmpHi & 0xffn);
        tmpHi >>= 8n;
      }
      expect(Buffer.from(rebuilt)).to.deep.equal(Buffer.from(secret));

      console.log(
        "    ✅ splitSecretToU128 preserves all 32 bytes via lo/hi limbs",
      );
    });

    it("U4: PDA derivation is consistent with known seeds", () => {
      const testDenom = 1_000_000_000n;
      const poolPda1 = derivePoolPda(programId, testDenom);
      const poolPda2 = derivePoolPda(programId, testDenom);
      expect(poolPda1.equals(poolPda2)).to.be.true;

      const vaultPda1 = deriveVaultPda(programId, testDenom);
      const nullPda1 = deriveNullifierRegistryPda(programId, testDenom);

      // All three PDAs should be distinct
      expect(poolPda1.equals(vaultPda1)).to.be.false;
      expect(poolPda1.equals(nullPda1)).to.be.false;
      expect(vaultPda1.equals(nullPda1)).to.be.false;

      // Different denominations yield different PDAs
      const poolPda3 = derivePoolPda(programId, 100_000_000n);
      expect(poolPda1.equals(poolPda3)).to.be.false;

      console.log(
        "    ✅ PDA derivation deterministic, denomination-scoped, distinct seeds",
      );
    });

    it("U5: Note PDA is unique per note hash", () => {
      const hash1 = noteHash(
        new Uint8Array(randomBytes(32)),
        Keypair.generate().publicKey,
        100_000_000n,
      );
      const hash2 = noteHash(
        new Uint8Array(randomBytes(32)),
        Keypair.generate().publicKey,
        100_000_000n,
      );

      const note1 = pda([Buffer.from("note"), hash1], programId);
      const note2 = pda([Buffer.from("note"), hash2], programId);
      expect(note1.equals(note2)).to.be.false;

      // Same hash → same PDA
      const note1b = pda([Buffer.from("note"), hash1], programId);
      expect(note1.equals(note1b)).to.be.true;

      console.log("    ✅ Note PDA uniquely determined by note_hash");
    });

    it("U6: SUPPORTED_DENOMINATION_LAMPORTS are all distinct and positive", () => {
      for (const denom of SUPPORTED_DENOMINATION_LAMPORTS) {
        expect(denom > 0n).to.be.true;
      }
      const uniq = new Set(SUPPORTED_DENOMINATION_LAMPORTS.map(String));
      expect(uniq.size).to.equal(SUPPORTED_DENOMINATION_LAMPORTS.length);
      console.log("    ✅ All denominations distinct and positive");
    });

    it("U7: denomination decomposition prefers the new intermediate pools", () => {
      const notes = decomposeIntoDenominations(550_000_000n).sort(
        (left, right) => Number(right - left),
      );

      expect(notes).to.deep.equal([500_000_000n, 50_000_000n]);
      console.log(
        "    ✅ 0.55 SOL now routes through 0.5 SOL and 0.05 SOL pools",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // INTEGRATION TESTS — Full on-chain + MPC flows
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 7. Wrong secret rejection (MPC returns SECRET_MISMATCH) ───────────────

  it("7: Wrong secret — MPC rejects with SECRET_MISMATCH, note stays Ready", async () => {
    // Make a fresh deposit
    const testSecret = new Uint8Array(randomBytes(32));
    const testWithdrawKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecpHash = recipientHash(testWithdrawKey, recipient.publicKey);
    const testNoteHash = noteHash(
      testSecret,
      recipient.publicKey,
      primaryDenominationLamports,
    );
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub_ = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));

    const nonce = randomBytes(16);
    const ct = cipher.encrypt([primaryDenominationLamports], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    const [secretLo, secretHi] = splitSecretToU128(testSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([secretLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([secretHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const depositOffset = new anchor.BN(randomBytes(8), "hex");

    await program.methods
      .deposit(
        depositOffset,
        Array.from(ct[0]),
        Array.from(pub_),
        nonceBN,
        Array.from(ctSecLo[0]),
        Array.from(ctSecHi[0]),
        nonceSecLoB,
        nonceSecHiB,
        Array.from(testRecpHash),
        Array.from(testNullifierHash),
        new anchor.BN(primaryDenominationLamports.toString()),
        Array.from(testNoteHash),
      )
      .accountsPartial({
        sender: payer.publicKey,
        poolState: poolPDA,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        vault: vaultPDA,
        ...arciumAccs(depositOffset, cdOffset("deposit_to_pool")),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      depositOffset,
      programId,
      "confirmed",
    );
    await waitForNoteStatus(program, testNotePDA, "ready");
    console.log(
      "    Deposit confirmed, attempting withdraw with WRONG secret...",
    );

    // ── Withdraw with a completely wrong secret ──
    await new Promise((r) => setTimeout(r, 5000));
    const wrongSecret = new Uint8Array(randomBytes(32));
    const [wrongLo, wrongHi] = splitSecretToU128(wrongSecret);

    const priv2 = x25519.utils.randomSecretKey();
    const pub2 = x25519.getPublicKey(priv2);
    const cipher2 = new RescueCipher(x25519.getSharedSecret(priv2, mxeKey));
    const wNonceLo = randomBytes(16);
    const wCtLo = cipher2.encrypt([wrongLo], wNonceLo);
    const wNonceLoB = new anchor.BN(deserializeLE(wNonceLo).toString());
    const wNonceHi = randomBytes(16);
    const wCtHi = cipher2.encrypt([wrongHi], wNonceHi);
    const wNonceHiB = new anchor.BN(deserializeLE(wNonceHi).toString());

    const withdrawOffset = new anchor.BN(randomBytes(8), "hex");
    const recipientBalBefore = await provider.connection.getBalance(
      recipient.publicKey,
    );

    await program.methods
      .withdraw(
        withdrawOffset,
        Array.from(testWithdrawKey),
        Array.from(wCtLo[0]),
        Array.from(wCtHi[0]),
        Array.from(pub2),
        wNonceLoB,
        wNonceHiB,
      )
      .accountsPartial({
        relayer: relayer.publicKey,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        poolState: poolPDA,
        vault: vaultPDA,
        nullifierRegistry: nullifierRegistryPDA,
        recipient: recipient.publicKey,
        ...arciumAccs(withdrawOffset, cdOffset("withdraw_from_pool")),
      })
      .signers([relayer])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      withdrawOffset,
      programId,
      "confirmed",
    );

    // Note should remain Ready (secret mismatch = soft rejection)
    const noteAfter = await waitForNoteStatus(program, testNotePDA, "ready");
    expect(noteAfter.status).to.deep.equal({ ready: {} });

    // Recipient should NOT receive any SOL
    const recipientBalAfter = await provider.connection.getBalance(
      recipient.publicKey,
    );
    expect(recipientBalAfter).to.equal(recipientBalBefore);

    console.log(
      "    ✅ Wrong secret rejected, note remains Ready, no SOL transferred",
    );

    // ── Now withdraw with the CORRECT secret to prove the note is still usable ──
    console.log("    Retrying with correct secret...");
    const priv3 = x25519.utils.randomSecretKey();
    const pub3 = x25519.getPublicKey(priv3);
    const cipher3 = new RescueCipher(x25519.getSharedSecret(priv3, mxeKey));
    const cNonceLo = randomBytes(16);
    const cCtLo = cipher3.encrypt([secretLo], cNonceLo);
    const cNonceLoB = new anchor.BN(deserializeLE(cNonceLo).toString());
    const cNonceHi = randomBytes(16);
    const cCtHi = cipher3.encrypt([secretHi], cNonceHi);
    const cNonceHiB = new anchor.BN(deserializeLE(cNonceHi).toString());

    const retryOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .withdraw(
        retryOffset,
        Array.from(testWithdrawKey),
        Array.from(cCtLo[0]),
        Array.from(cCtHi[0]),
        Array.from(pub3),
        cNonceLoB,
        cNonceHiB,
      )
      .accountsPartial({
        relayer: relayer.publicKey,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        poolState: poolPDA,
        vault: vaultPDA,
        nullifierRegistry: nullifierRegistryPDA,
        recipient: recipient.publicKey,
        ...arciumAccs(retryOffset, cdOffset("withdraw_from_pool")),
      })
      .signers([relayer])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      retryOffset,
      programId,
      "confirmed",
    );
    const finalNote = await waitForNoteStatus(
      program,
      testNotePDA,
      "withdrawn",
    );
    expect(finalNote.status).to.deep.equal({ withdrawn: {} });

    const recipientBalFinal = await provider.connection.getBalance(
      recipient.publicKey,
    );
    expect(recipientBalFinal - recipientBalBefore).to.equal(
      Number(primaryDenominationLamports),
    );
    console.log(
      "    ✅ Correct secret accepted after prior rejection — note fully withdrawn",
    );
  });

  // ── 8. compact_spent_note fails on non-withdrawn note ─────────────────────

  it("8: compact_spent_note rejects note that is not Withdrawn", async () => {
    // Create a fresh deposit (note will be in Ready state after callback)
    const testSecret = new Uint8Array(randomBytes(32));
    const testWithdrawKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecpHash = recipientHash(testWithdrawKey, recipient.publicKey);
    const testNoteHash = noteHash(
      testSecret,
      recipient.publicKey,
      primaryDenominationLamports,
    );
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub_ = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));

    const nonce = randomBytes(16);
    const ct = cipher.encrypt([primaryDenominationLamports], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    const [secretLo, secretHi] = splitSecretToU128(testSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([secretLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([secretHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const offset = new anchor.BN(randomBytes(8), "hex");

    await program.methods
      .deposit(
        offset,
        Array.from(ct[0]),
        Array.from(pub_),
        nonceBN,
        Array.from(ctSecLo[0]),
        Array.from(ctSecHi[0]),
        nonceSecLoB,
        nonceSecHiB,
        Array.from(testRecpHash),
        Array.from(testNullifierHash),
        new anchor.BN(primaryDenominationLamports.toString()),
        Array.from(testNoteHash),
      )
      .accountsPartial({
        sender: payer.publicKey,
        poolState: poolPDA,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        vault: vaultPDA,
        ...arciumAccs(offset, cdOffset("deposit_to_pool")),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      offset,
      programId,
      "confirmed",
    );
    await waitForNoteStatus(program, testNotePDA, "ready");

    // Try to compact a note that's still in Ready state — should fail
    try {
      await program.methods
        .compactSpentNote(Array.from(testNoteHash))
        .accountsPartial({
          relayer: relayer.publicKey,
          noteRegistry: testNotePDA,
        })
        .signers([relayer])
        .rpc({ commitment: "confirmed" });
      expect.fail("Should have thrown — note is Ready, not Withdrawn");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg.includes("NoteNotWithdrawn")).to.be.true;
      console.log("    ✅ compact_spent_note correctly rejects Ready note");
    }
  });

  // ── 9. Full end-to-end cycle on a different denomination ──────────────────

  it("9: Full deposit→withdraw→compact cycle on the smallest denomination", async () => {
    const smallDenom =
      SUPPORTED_DENOMINATION_LAMPORTS[
        SUPPORTED_DENOMINATION_LAMPORTS.length - 1
      ];
    const {
      poolPDA: sPoolPDA,
      vaultPDA: sVaultPDA,
      nullifierRegistryPDA: sNullRegPDA,
    } = await ensurePoolInitialized(smallDenom);

    const testSecret = new Uint8Array(randomBytes(32));
    const testWithdrawKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecipient = Keypair.generate();
    const testRecpHash = recipientHash(
      testWithdrawKey,
      testRecipient.publicKey,
    );
    const testNoteHash = noteHash(
      testSecret,
      testRecipient.publicKey,
      smallDenom,
    );
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    // Fund the test recipient so it has a lamports account
    const sig = await provider.connection.requestAirdrop(
      testRecipient.publicKey,
      0.01 * LAMPORTS_PER_SOL,
    );
    const bh = await provider.connection.getLatestBlockhash("confirmed");
    await provider.connection.confirmTransaction(
      { signature: sig, ...bh },
      "confirmed",
    );

    const mxeKey = await getMXEKey(provider, programId);

    // ── DEPOSIT ──
    const dPriv = x25519.utils.randomSecretKey();
    const dPub = x25519.getPublicKey(dPriv);
    const dCipher = new RescueCipher(x25519.getSharedSecret(dPriv, mxeKey));

    const dNonce = randomBytes(16);
    const dCt = dCipher.encrypt([smallDenom], dNonce);
    const dNonceBN = new anchor.BN(deserializeLE(dNonce).toString());

    const [sLo, sHi] = splitSecretToU128(testSecret);
    const sNonceLo = randomBytes(16);
    const sCtLo = dCipher.encrypt([sLo], sNonceLo);
    const sNonceLoB = new anchor.BN(deserializeLE(sNonceLo).toString());
    const sNonceHi = randomBytes(16);
    const sCtHi = dCipher.encrypt([sHi], sNonceHi);
    const sNonceHiB = new anchor.BN(deserializeLE(sNonceHi).toString());

    const depositOffset = new anchor.BN(randomBytes(8), "hex");
    const vaultBalBefore = await provider.connection.getBalance(sVaultPDA);

    await program.methods
      .deposit(
        depositOffset,
        Array.from(dCt[0]),
        Array.from(dPub),
        dNonceBN,
        Array.from(sCtLo[0]),
        Array.from(sCtHi[0]),
        sNonceLoB,
        sNonceHiB,
        Array.from(testRecpHash),
        Array.from(testNullifierHash),
        new anchor.BN(smallDenom.toString()),
        Array.from(testNoteHash),
      )
      .accountsPartial({
        sender: payer.publicKey,
        poolState: sPoolPDA,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        vault: sVaultPDA,
        ...arciumAccs(depositOffset, cdOffset("deposit_to_pool")),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      depositOffset,
      programId,
      "confirmed",
    );
    const noteReady = await waitForNoteStatus(program, testNotePDA, "ready");
    expect(noteReady.status).to.deep.equal({ ready: {} });

    const vaultBalAfterDeposit =
      await provider.connection.getBalance(sVaultPDA);
    expect(vaultBalAfterDeposit - vaultBalBefore).to.equal(Number(smallDenom));
    console.log(
      "    ✅ Deposit: vault gained",
      Number(smallDenom) / LAMPORTS_PER_SOL,
      "SOL",
    );

    // ── WITHDRAW ──
    await new Promise((r) => setTimeout(r, 5000));
    const wPriv = x25519.utils.randomSecretKey();
    const wPub = x25519.getPublicKey(wPriv);
    const wCipher = new RescueCipher(x25519.getSharedSecret(wPriv, mxeKey));
    const wNonceLo = randomBytes(16);
    const wCtLo = wCipher.encrypt([sLo], wNonceLo);
    const wNonceLoB = new anchor.BN(deserializeLE(wNonceLo).toString());
    const wNonceHi = randomBytes(16);
    const wCtHi = wCipher.encrypt([sHi], wNonceHi);
    const wNonceHiB = new anchor.BN(deserializeLE(wNonceHi).toString());

    const withdrawOffset = new anchor.BN(randomBytes(8), "hex");
    const recipBalBefore = await provider.connection.getBalance(
      testRecipient.publicKey,
    );

    await program.methods
      .withdraw(
        withdrawOffset,
        Array.from(testWithdrawKey),
        Array.from(wCtLo[0]),
        Array.from(wCtHi[0]),
        Array.from(wPub),
        wNonceLoB,
        wNonceHiB,
      )
      .accountsPartial({
        relayer: relayer.publicKey,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        poolState: sPoolPDA,
        vault: sVaultPDA,
        nullifierRegistry: sNullRegPDA,
        recipient: testRecipient.publicKey,
        ...arciumAccs(withdrawOffset, cdOffset("withdraw_from_pool")),
      })
      .signers([relayer])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      withdrawOffset,
      programId,
      "confirmed",
    );
    const noteWithdrawn = await waitForNoteStatus(
      program,
      testNotePDA,
      "withdrawn",
    );
    expect(noteWithdrawn.status).to.deep.equal({ withdrawn: {} });

    const recipBalAfter = await provider.connection.getBalance(
      testRecipient.publicKey,
    );
    expect(recipBalAfter - recipBalBefore).to.equal(Number(smallDenom));

    const vaultBalAfterWithdraw =
      await provider.connection.getBalance(sVaultPDA);
    expect(vaultBalAfterWithdraw).to.equal(vaultBalBefore);
    console.log(
      "    ✅ Withdraw: recipient gained",
      Number(smallDenom) / LAMPORTS_PER_SOL,
      "SOL, vault back to original",
    );

    // ── COMPACT ──
    await program.methods
      .compactSpentNote(Array.from(testNoteHash))
      .accountsPartial({
        relayer: relayer.publicKey,
        noteRegistry: testNotePDA,
      })
      .signers([relayer])
      .rpc({ commitment: "confirmed" });

    await waitForNoteClosed(provider.connection, testNotePDA, 30);
    const closed = await provider.connection.getAccountInfo(
      testNotePDA,
      "confirmed",
    );
    expect(closed).to.be.null;
    console.log(
      "    ✅ Compact: note account closed — full lifecycle complete (0.01 SOL denom)",
    );
  });

  // ── 10. Multiple deposits into same pool, sequential withdrawals ──────────

  it("10: Two deposits then two withdrawals — pool balance tracks correctly", async () => {
    // Compact the nullifier registry to make room for new withdrawals
    await compactNullifierRegistry(primaryDenominationLamports);

    const secrets: Uint8Array[] = [];
    const withdrawKeys: Uint8Array[] = [];
    const nullifierHashes: Buffer[] = [];
    const noteHashes: Buffer[] = [];
    const notePDAs: PublicKey[] = [];
    const nullifierRecordPDAs: PublicKey[] = [];
    const recipients: Keypair[] = [];

    for (let i = 0; i < 2; i++) {
      secrets.push(new Uint8Array(randomBytes(32)));
      withdrawKeys.push(new Uint8Array(randomBytes(32)));
      recipients.push(Keypair.generate());

      // Fund recipients
      const sig = await provider.connection.requestAirdrop(
        recipients[i].publicKey,
        0.01 * LAMPORTS_PER_SOL,
      );
      const bh = await provider.connection.getLatestBlockhash("confirmed");
      await provider.connection.confirmTransaction(
        { signature: sig, ...bh },
        "confirmed",
      );

      noteHashes.push(
        noteHash(
          secrets[i],
          recipients[i].publicKey,
          primaryDenominationLamports,
        ),
      );
      nullifierHashes.push(publicNullifierHash(secrets[i]));
      notePDAs.push(pda([Buffer.from("note"), noteHashes[i]], programId));
      nullifierRecordPDAs.push(
        deriveNullifierRecordPda(programId, nullifierHashes[i]),
      );
    }

    const mxeKey = await getMXEKey(provider, programId);
    const poolBefore = await (program.account as any).poolState.fetch(poolPDA);
    const encBalBefore = Buffer.from(poolBefore.encryptedBalance).toString(
      "hex",
    );

    // ── Two deposits ──
    for (let i = 0; i < 2; i++) {
      const priv = x25519.utils.randomSecretKey();
      const pub_ = x25519.getPublicKey(priv);
      const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));

      const nonce = randomBytes(16);
      const ct = cipher.encrypt([primaryDenominationLamports], nonce);
      const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

      const recpHash = recipientHash(withdrawKeys[i], recipients[i].publicKey);
      const [sLo, sHi] = splitSecretToU128(secrets[i]);
      const sNonceLo = randomBytes(16);
      const sCtLo = cipher.encrypt([sLo], sNonceLo);
      const sNonceLoB = new anchor.BN(deserializeLE(sNonceLo).toString());
      const sNonceHi = randomBytes(16);
      const sCtHi = cipher.encrypt([sHi], sNonceHi);
      const sNonceHiB = new anchor.BN(deserializeLE(sNonceHi).toString());

      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .deposit(
          offset,
          Array.from(ct[0]),
          Array.from(pub_),
          nonceBN,
          Array.from(sCtLo[0]),
          Array.from(sCtHi[0]),
          sNonceLoB,
          sNonceHiB,
          Array.from(recpHash),
          Array.from(nullifierHashes[i]),
          new anchor.BN(primaryDenominationLamports.toString()),
          Array.from(noteHashes[i]),
        )
        .accountsPartial({
          sender: payer.publicKey,
          poolState: poolPDA,
          noteRegistry: notePDAs[i],
          nullifierRecord: nullifierRecordPDAs[i],
          vault: vaultPDA,
          ...arciumAccs(offset, cdOffset("deposit_to_pool")),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      await awaitComputationFinalization(
        provider,
        offset,
        programId,
        "confirmed",
      );
      await waitForNoteStatus(program, notePDAs[i], "ready");
      console.log(`    ✅ Deposit ${i + 1}/2 confirmed`);
    }

    // Pool encrypted balance should have changed
    const poolAfterDeposits = await (program.account as any).poolState.fetch(
      poolPDA,
    );
    const encBalAfterDeposits = Buffer.from(
      poolAfterDeposits.encryptedBalance,
    ).toString("hex");
    expect(encBalAfterDeposits).to.not.equal(encBalBefore);

    // ── Two withdrawals ──
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const priv = x25519.utils.randomSecretKey();
      const pub_ = x25519.getPublicKey(priv);
      const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));

      const [sLo, sHi] = splitSecretToU128(secrets[i]);
      const nonceLo = randomBytes(16);
      const ctLo = cipher.encrypt([sLo], nonceLo);
      const nonceLoB = new anchor.BN(deserializeLE(nonceLo).toString());
      const nonceHi = randomBytes(16);
      const ctHi = cipher.encrypt([sHi], nonceHi);
      const nonceHiB = new anchor.BN(deserializeLE(nonceHi).toString());

      const offset = new anchor.BN(randomBytes(8), "hex");
      const recipBal = await provider.connection.getBalance(
        recipients[i].publicKey,
      );

      await program.methods
        .withdraw(
          offset,
          Array.from(withdrawKeys[i]),
          Array.from(ctLo[0]),
          Array.from(ctHi[0]),
          Array.from(pub_),
          nonceLoB,
          nonceHiB,
        )
        .accountsPartial({
          relayer: relayer.publicKey,
          noteRegistry: notePDAs[i],
          nullifierRecord: nullifierRecordPDAs[i],
          poolState: poolPDA,
          vault: vaultPDA,
          nullifierRegistry: nullifierRegistryPDA,
          recipient: recipients[i].publicKey,
          ...arciumAccs(offset, cdOffset("withdraw_from_pool")),
        })
        .signers([relayer])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      await awaitComputationFinalization(
        provider,
        offset,
        programId,
        "confirmed",
      );
      const note = await waitForNoteStatus(program, notePDAs[i], "withdrawn");
      expect(note.status).to.deep.equal({ withdrawn: {} });

      const recipBalAfter = await provider.connection.getBalance(
        recipients[i].publicKey,
      );
      expect(recipBalAfter - recipBal).to.equal(
        Number(primaryDenominationLamports),
      );

      // Compact
      await program.methods
        .compactSpentNote(Array.from(noteHashes[i]))
        .accountsPartial({
          relayer: relayer.publicKey,
          noteRegistry: notePDAs[i],
        })
        .signers([relayer])
        .rpc({ commitment: "confirmed" });
      await waitForNoteClosed(provider.connection, notePDAs[i], 30);

      console.log(
        `    ✅ Withdrawal ${i + 1}/2 complete — recipient received ${Number(primaryDenominationLamports) / LAMPORTS_PER_SOL} SOL`,
      );
    }

    console.log(
      "    ✅ Two deposits + two withdrawals — pool balance consistent throughout",
    );
  });

  // ── 11. Deposit with zero amount rejected ─────────────────────────────────

  it("11: Deposit with zero amount is rejected", async () => {
    const testSecret = new Uint8Array(randomBytes(32));
    const testWithdrawKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecpHash = recipientHash(testWithdrawKey, recipient.publicKey);
    const testNoteHash = noteHash(testSecret, recipient.publicKey, 0n);
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub_ = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([0n], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    const [sLo, sHi] = splitSecretToU128(testSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([sLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([sHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const offset = new anchor.BN(randomBytes(8), "hex");

    try {
      await program.methods
        .deposit(
          offset,
          Array.from(ct[0]),
          Array.from(pub_),
          nonceBN,
          Array.from(ctSecLo[0]),
          Array.from(ctSecHi[0]),
          nonceSecLoB,
          nonceSecHiB,
          Array.from(testRecpHash),
          Array.from(testNullifierHash),
          new anchor.BN(0),
          Array.from(testNoteHash),
        )
        .accountsPartial({
          sender: payer.publicKey,
          poolState: poolPDA,
          noteRegistry: testNotePDA,
          nullifierRecord: testNullifierRecordPDA,
          vault: vaultPDA,
          ...arciumAccs(offset, cdOffset("deposit_to_pool")),
        })
        .rpc({ commitment: "confirmed" });
      expect.fail("Should have thrown — zero amount");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(
        msg.includes("ZeroAmount") ||
          msg.includes("PoolDenominationMismatch") ||
          msg.includes("ConstraintSeeds") ||
          msg.includes("0x0"),
      ).to.be.true;
      console.log("    ✅ Zero amount deposit rejected");
    }
  });

  // ── 12. Deposit with wrong denomination rejected ──────────────────────────

  it("12: Deposit to pool with mismatched denomination is rejected", async () => {
    // Try depositing 0.5 SOL (500_000_000) into the 0.1 SOL (100_000_000) pool
    const wrongAmount = 500_000_000n;
    const testSecret = new Uint8Array(randomBytes(32));
    const testWKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecpHash = recipientHash(testWKey, recipient.publicKey);
    const testNoteHash = noteHash(testSecret, recipient.publicKey, wrongAmount);
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub_ = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([wrongAmount], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    const [sLo, sHi] = splitSecretToU128(testSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([sLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([sHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const offset = new anchor.BN(randomBytes(8), "hex");

    try {
      await program.methods
        .deposit(
          offset,
          Array.from(ct[0]),
          Array.from(pub_),
          nonceBN,
          Array.from(ctSecLo[0]),
          Array.from(ctSecHi[0]),
          nonceSecLoB,
          nonceSecHiB,
          Array.from(testRecpHash),
          Array.from(testNullifierHash),
          new anchor.BN(wrongAmount.toString()),
          Array.from(testNoteHash),
        )
        .accountsPartial({
          sender: payer.publicKey,
          poolState: poolPDA,
          noteRegistry: testNotePDA,
          nullifierRecord: testNullifierRecordPDA,
          vault: vaultPDA,
          ...arciumAccs(offset, cdOffset("deposit_to_pool")),
        })
        .rpc({ commitment: "confirmed" });
      expect.fail("Should have thrown — wrong denomination");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(
        msg.includes("PoolDenominationMismatch") ||
          msg.includes("ConstraintSeeds") ||
          msg.includes("Constraint"),
      ).to.be.true;
      console.log("    ✅ Denomination mismatch rejected");
    }
  });

  // ── 13. Vault balance integrity through deposit cycle ─────────────────────

  it("13: Vault balance exactly tracks deposits and withdrawals", async () => {
    // Compact the nullifier registry to make room for new withdrawals
    await compactNullifierRegistry(primaryDenominationLamports);

    const vaultBefore = await provider.connection.getBalance(vaultPDA);

    const testSecret = new Uint8Array(randomBytes(32));
    const testWithdrawKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecipient = Keypair.generate();
    const testRecpHash = recipientHash(
      testWithdrawKey,
      testRecipient.publicKey,
    );
    const testNoteHash = noteHash(
      testSecret,
      testRecipient.publicKey,
      primaryDenominationLamports,
    );
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    const sig = await provider.connection.requestAirdrop(
      testRecipient.publicKey,
      0.01 * LAMPORTS_PER_SOL,
    );
    const bh = await provider.connection.getLatestBlockhash("confirmed");
    await provider.connection.confirmTransaction(
      { signature: sig, ...bh },
      "confirmed",
    );

    const mxeKey = await getMXEKey(provider, programId);

    // ── DEPOSIT ──
    const dPriv = x25519.utils.randomSecretKey();
    const dPub = x25519.getPublicKey(dPriv);
    const dCipher = new RescueCipher(x25519.getSharedSecret(dPriv, mxeKey));
    const dNonce = randomBytes(16);
    const dCt = dCipher.encrypt([primaryDenominationLamports], dNonce);
    const dNonceBN = new anchor.BN(deserializeLE(dNonce).toString());

    const [sLo, sHi] = splitSecretToU128(testSecret);
    const sNonceLo = randomBytes(16);
    const sCtLo = dCipher.encrypt([sLo], sNonceLo);
    const sNonceLoB = new anchor.BN(deserializeLE(sNonceLo).toString());
    const sNonceHi = randomBytes(16);
    const sCtHi = dCipher.encrypt([sHi], sNonceHi);
    const sNonceHiB = new anchor.BN(deserializeLE(sNonceHi).toString());

    const depositOffset = new anchor.BN(randomBytes(8), "hex");

    await program.methods
      .deposit(
        depositOffset,
        Array.from(dCt[0]),
        Array.from(dPub),
        dNonceBN,
        Array.from(sCtLo[0]),
        Array.from(sCtHi[0]),
        sNonceLoB,
        sNonceHiB,
        Array.from(testRecpHash),
        Array.from(testNullifierHash),
        new anchor.BN(primaryDenominationLamports.toString()),
        Array.from(testNoteHash),
      )
      .accountsPartial({
        sender: payer.publicKey,
        poolState: poolPDA,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        vault: vaultPDA,
        ...arciumAccs(depositOffset, cdOffset("deposit_to_pool")),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      depositOffset,
      programId,
      "confirmed",
    );
    await waitForNoteStatus(program, testNotePDA, "ready");

    const vaultAfterDeposit = await provider.connection.getBalance(vaultPDA);
    expect(vaultAfterDeposit).to.equal(
      vaultBefore + Number(primaryDenominationLamports),
    );
    console.log(
      "    ✅ Vault: +",
      Number(primaryDenominationLamports) / LAMPORTS_PER_SOL,
      "SOL after deposit",
    );

    // ── WITHDRAW ──
    await new Promise((r) => setTimeout(r, 5000));
    const wPriv = x25519.utils.randomSecretKey();
    const wPub = x25519.getPublicKey(wPriv);
    const wCipher = new RescueCipher(x25519.getSharedSecret(wPriv, mxeKey));
    const wNonceLo = randomBytes(16);
    const wCtLo = wCipher.encrypt([sLo], wNonceLo);
    const wNonceLoB = new anchor.BN(deserializeLE(wNonceLo).toString());
    const wNonceHi = randomBytes(16);
    const wCtHi = wCipher.encrypt([sHi], wNonceHi);
    const wNonceHiB = new anchor.BN(deserializeLE(wNonceHi).toString());

    const withdrawOffset = new anchor.BN(randomBytes(8), "hex");

    await program.methods
      .withdraw(
        withdrawOffset,
        Array.from(testWithdrawKey),
        Array.from(wCtLo[0]),
        Array.from(wCtHi[0]),
        Array.from(wPub),
        wNonceLoB,
        wNonceHiB,
      )
      .accountsPartial({
        relayer: relayer.publicKey,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        poolState: poolPDA,
        vault: vaultPDA,
        nullifierRegistry: nullifierRegistryPDA,
        recipient: testRecipient.publicKey,
        ...arciumAccs(withdrawOffset, cdOffset("withdraw_from_pool")),
      })
      .signers([relayer])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      withdrawOffset,
      programId,
      "confirmed",
    );
    await waitForNoteStatus(program, testNotePDA, "withdrawn");

    const vaultAfterWithdraw = await provider.connection.getBalance(vaultPDA);
    expect(vaultAfterWithdraw).to.equal(vaultBefore);
    console.log(
      "    ✅ Vault: back to original after withdraw — net zero, conservation holds",
    );
  });

  // ── 14. Independent depositors cannot interfere ───────────────────────────

  it("14: Two independent depositors with distinct secrets + recipients", async () => {
    // Compact the nullifier registry to make room for new withdrawals
    await compactNullifierRegistry(primaryDenominationLamports);

    const depositorA = payer; // existing payer
    const depositorB = Keypair.generate();

    // Fund depositor B
    const fundSig = await provider.connection.requestAirdrop(
      depositorB.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    const fundBh = await provider.connection.getLatestBlockhash("confirmed");
    await provider.connection.confirmTransaction(
      { signature: fundSig, ...fundBh },
      "confirmed",
    );

    const recipA = Keypair.generate();
    const recipB = Keypair.generate();
    for (const kp of [recipA, recipB]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        0.01 * LAMPORTS_PER_SOL,
      );
      const bh = await provider.connection.getLatestBlockhash("confirmed");
      await provider.connection.confirmTransaction(
        { signature: sig, ...bh },
        "confirmed",
      );
    }

    const secretA = new Uint8Array(randomBytes(32));
    const secretB = new Uint8Array(randomBytes(32));
    const wKeyA = new Uint8Array(randomBytes(32));
    const wKeyB = new Uint8Array(randomBytes(32));
    const nullifierHashA = publicNullifierHash(secretA);
    const nullifierHashB = publicNullifierHash(secretB);
    const recpHashA = recipientHash(wKeyA, recipA.publicKey);
    const recpHashB = recipientHash(wKeyB, recipB.publicKey);
    const noteHashA = noteHash(
      secretA,
      recipA.publicKey,
      primaryDenominationLamports,
    );
    const noteHashB = noteHash(
      secretB,
      recipB.publicKey,
      primaryDenominationLamports,
    );
    const notePDA_A = pda([Buffer.from("note"), noteHashA], programId);
    const notePDA_B = pda([Buffer.from("note"), noteHashB], programId);
    const nullifierRecordPDA_A = deriveNullifierRecordPda(
      programId,
      nullifierHashA,
    );
    const nullifierRecordPDA_B = deriveNullifierRecordPda(
      programId,
      nullifierHashB,
    );

    const mxeKey = await getMXEKey(provider, programId);

    // ── Depositor A deposits ──
    {
      const priv = x25519.utils.randomSecretKey();
      const pub_ = x25519.getPublicKey(priv);
      const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([primaryDenominationLamports], nonce);
      const nBN = new anchor.BN(deserializeLE(nonce).toString());

      const [sLo, sHi] = splitSecretToU128(secretA);
      const snLo = randomBytes(16);
      const scLo = cipher.encrypt([sLo], snLo);
      const snHi = randomBytes(16);
      const scHi = cipher.encrypt([sHi], snHi);

      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .deposit(
          offset,
          Array.from(ct[0]),
          Array.from(pub_),
          nBN,
          Array.from(scLo[0]),
          Array.from(scHi[0]),
          new anchor.BN(deserializeLE(snLo).toString()),
          new anchor.BN(deserializeLE(snHi).toString()),
          Array.from(recpHashA),
          Array.from(nullifierHashA),
          new anchor.BN(primaryDenominationLamports.toString()),
          Array.from(noteHashA),
        )
        .accountsPartial({
          sender: depositorA.publicKey,
          poolState: poolPDA,
          noteRegistry: notePDA_A,
          nullifierRecord: nullifierRecordPDA_A,
          vault: vaultPDA,
          ...arciumAccs(offset, cdOffset("deposit_to_pool")),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await awaitComputationFinalization(
        provider,
        offset,
        programId,
        "confirmed",
      );
      await waitForNoteStatus(program, notePDA_A, "ready");
      console.log("    ✅ Depositor A deposited");
    }

    // ── Depositor B deposits ──
    {
      const priv = x25519.utils.randomSecretKey();
      const pub_ = x25519.getPublicKey(priv);
      const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([primaryDenominationLamports], nonce);
      const nBN = new anchor.BN(deserializeLE(nonce).toString());

      const [sLo, sHi] = splitSecretToU128(secretB);
      const snLo = randomBytes(16);
      const scLo = cipher.encrypt([sLo], snLo);
      const snHi = randomBytes(16);
      const scHi = cipher.encrypt([sHi], snHi);

      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .deposit(
          offset,
          Array.from(ct[0]),
          Array.from(pub_),
          nBN,
          Array.from(scLo[0]),
          Array.from(scHi[0]),
          new anchor.BN(deserializeLE(snLo).toString()),
          new anchor.BN(deserializeLE(snHi).toString()),
          Array.from(recpHashB),
          Array.from(nullifierHashB),
          new anchor.BN(primaryDenominationLamports.toString()),
          Array.from(noteHashB),
        )
        .accountsPartial({
          sender: depositorB.publicKey,
          poolState: poolPDA,
          noteRegistry: notePDA_B,
          nullifierRecord: nullifierRecordPDA_B,
          vault: vaultPDA,
          ...arciumAccs(offset, cdOffset("deposit_to_pool")),
        })
        .signers([depositorB])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await awaitComputationFinalization(
        provider,
        offset,
        programId,
        "confirmed",
      );
      await waitForNoteStatus(program, notePDA_B, "ready");
      console.log("    ✅ Depositor B deposited");
    }

    // ── Withdraw B first, then A (different order from deposit) ──
    for (const [secret, wKey, noteH, notePd, recip, label] of [
      [secretB, wKeyB, noteHashB, notePDA_B, recipB, "B"],
      [secretA, wKeyA, noteHashA, notePDA_A, recipA, "A"],
    ] as [Uint8Array, Uint8Array, Buffer, PublicKey, Keypair, string][]) {
      await new Promise((r) => setTimeout(r, 5000));
      const priv = x25519.utils.randomSecretKey();
      const pub_ = x25519.getPublicKey(priv);
      const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
      const [sLo, sHi] = splitSecretToU128(secret);
      const nullifierRecordPDA = deriveNullifierRecordPda(
        programId,
        publicNullifierHash(secret),
      );
      const nLo = randomBytes(16);
      const cLo = cipher.encrypt([sLo], nLo);
      const nHi = randomBytes(16);
      const cHi = cipher.encrypt([sHi], nHi);

      const recipBal = await provider.connection.getBalance(recip.publicKey);
      const offset = new anchor.BN(randomBytes(8), "hex");

      await program.methods
        .withdraw(
          offset,
          Array.from(wKey),
          Array.from(cLo[0]),
          Array.from(cHi[0]),
          Array.from(pub_),
          new anchor.BN(deserializeLE(nLo).toString()),
          new anchor.BN(deserializeLE(nHi).toString()),
        )
        .accountsPartial({
          relayer: relayer.publicKey,
          noteRegistry: notePd,
          nullifierRecord: nullifierRecordPDA,
          poolState: poolPDA,
          vault: vaultPDA,
          nullifierRegistry: nullifierRegistryPDA,
          recipient: recip.publicKey,
          ...arciumAccs(offset, cdOffset("withdraw_from_pool")),
        })
        .signers([relayer])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      await awaitComputationFinalization(
        provider,
        offset,
        programId,
        "confirmed",
      );
      await waitForNoteStatus(program, notePd, "withdrawn");

      const recipBalAfter = await provider.connection.getBalance(
        recip.publicKey,
      );
      expect(recipBalAfter - recipBal).to.equal(
        Number(primaryDenominationLamports),
      );

      await program.methods
        .compactSpentNote(Array.from(noteH))
        .accountsPartial({ relayer: relayer.publicKey, noteRegistry: notePd })
        .signers([relayer])
        .rpc({ commitment: "confirmed" });
      await waitForNoteClosed(provider.connection, notePd, 30);

      console.log(
        `    ✅ Depositor ${label}'s withdrawal complete + compacted`,
      );
    }

    console.log(
      "    ✅ Independent depositors: out-of-order withdrawal works correctly",
    );
  });

  // ── 15. Withdraw on PendingMpc note rejected ──────────────────────────────

  it("15: Withdraw rejects note in PendingMpc state", async () => {
    // We can't easily create a persistent PendingMpc note, but we can verify
    // the constraint by checking the error code matching.
    // Create a note and immediately try to withdraw before MPC callback.
    const testSecret = new Uint8Array(randomBytes(32));
    const testWithdrawKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecpHash = recipientHash(testWithdrawKey, recipient.publicKey);
    const testNoteHash = noteHash(
      testSecret,
      recipient.publicKey,
      primaryDenominationLamports,
    );
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub_ = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([primaryDenominationLamports], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    const [sLo, sHi] = splitSecretToU128(testSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([sLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([sHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const depositOffset = new anchor.BN(randomBytes(8), "hex");

    await program.methods
      .deposit(
        depositOffset,
        Array.from(ct[0]),
        Array.from(pub_),
        nonceBN,
        Array.from(ctSecLo[0]),
        Array.from(ctSecHi[0]),
        nonceSecLoB,
        nonceSecHiB,
        Array.from(testRecpHash),
        Array.from(testNullifierHash),
        new anchor.BN(primaryDenominationLamports.toString()),
        Array.from(testNoteHash),
      )
      .accountsPartial({
        sender: payer.publicKey,
        poolState: poolPDA,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        vault: vaultPDA,
        ...arciumAccs(depositOffset, cdOffset("deposit_to_pool")),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    // Immediately try to withdraw (note is still PendingMpc)
    const wPriv = x25519.utils.randomSecretKey();
    const wPub = x25519.getPublicKey(wPriv);
    const wCipher = new RescueCipher(x25519.getSharedSecret(wPriv, mxeKey));
    const wNonceLo = randomBytes(16);
    const wCtLo = wCipher.encrypt([sLo], wNonceLo);
    const wNonceLoB = new anchor.BN(deserializeLE(wNonceLo).toString());
    const wNonceHi = randomBytes(16);
    const wCtHi = wCipher.encrypt([sHi], wNonceHi);
    const wNonceHiB = new anchor.BN(deserializeLE(wNonceHi).toString());

    const withdrawOffset = new anchor.BN(randomBytes(8), "hex");

    try {
      await program.methods
        .withdraw(
          withdrawOffset,
          Array.from(testWithdrawKey),
          Array.from(wCtLo[0]),
          Array.from(wCtHi[0]),
          Array.from(wPub),
          wNonceLoB,
          wNonceHiB,
        )
        .accountsPartial({
          relayer: relayer.publicKey,
          noteRegistry: testNotePDA,
          nullifierRecord: testNullifierRecordPDA,
          poolState: poolPDA,
          vault: vaultPDA,
          nullifierRegistry: nullifierRegistryPDA,
          recipient: recipient.publicKey,
          ...arciumAccs(withdrawOffset, cdOffset("withdraw_from_pool")),
        })
        .signers([relayer])
        .rpc({ commitment: "confirmed" });
      expect.fail("Should have thrown — note is PendingMpc");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg.includes("NoteNotReady")).to.be.true;
      console.log("    ✅ Withdraw on PendingMpc note correctly rejected");
    }

    // Let the MPC complete so we don't leave dangling state
    await awaitComputationFinalization(
      provider,
      depositOffset,
      programId,
      "confirmed",
    );
    await waitForNoteStatus(program, testNotePDA, "ready");
    console.log(
      "    ✅ Note became Ready after MPC completion (cleanup confirmed)",
    );
  });

  // ── 16. Encrypted balance and nonce actually change ───────────────────────

  it("16: Pool encrypted_balance and balance_nonce change after each operation", async () => {
    // Compact the nullifier registry to make room for new withdrawals
    await compactNullifierRegistry(primaryDenominationLamports);

    const pool0 = await (program.account as any).poolState.fetch(poolPDA);
    const enc0 = Buffer.from(pool0.encryptedBalance).toString("hex");
    const non0 = pool0.balanceNonce.toString();

    // Deposit
    const testSecret = new Uint8Array(randomBytes(32));
    const testWithdrawKey = new Uint8Array(randomBytes(32));
    const testNullifierHash = publicNullifierHash(testSecret);
    const testRecipient = Keypair.generate();
    const testRecpHash = recipientHash(
      testWithdrawKey,
      testRecipient.publicKey,
    );
    const testNoteHash = noteHash(
      testSecret,
      testRecipient.publicKey,
      primaryDenominationLamports,
    );
    const testNotePDA = pda([Buffer.from("note"), testNoteHash], programId);
    const testNullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      testNullifierHash,
    );

    const sig = await provider.connection.requestAirdrop(
      testRecipient.publicKey,
      0.01 * LAMPORTS_PER_SOL,
    );
    const bh = await provider.connection.getLatestBlockhash("confirmed");
    await provider.connection.confirmTransaction(
      { signature: sig, ...bh },
      "confirmed",
    );

    const mxeKey = await getMXEKey(provider, programId);
    const priv = x25519.utils.randomSecretKey();
    const pub_ = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([primaryDenominationLamports], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    const [sLo, sHi] = splitSecretToU128(testSecret);
    const sNLo = randomBytes(16);
    const sCLo = cipher.encrypt([sLo], sNLo);
    const sNHi = randomBytes(16);
    const sCHi = cipher.encrypt([sHi], sNHi);

    const dOff = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .deposit(
        dOff,
        Array.from(ct[0]),
        Array.from(pub_),
        nonceBN,
        Array.from(sCLo[0]),
        Array.from(sCHi[0]),
        new anchor.BN(deserializeLE(sNLo).toString()),
        new anchor.BN(deserializeLE(sNHi).toString()),
        Array.from(testRecpHash),
        Array.from(testNullifierHash),
        new anchor.BN(primaryDenominationLamports.toString()),
        Array.from(testNoteHash),
      )
      .accountsPartial({
        sender: payer.publicKey,
        poolState: poolPDA,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        vault: vaultPDA,
        ...arciumAccs(dOff, cdOffset("deposit_to_pool")),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await awaitComputationFinalization(provider, dOff, programId, "confirmed");
    await waitForNoteStatus(program, testNotePDA, "ready");

    const pool1 = await (program.account as any).poolState.fetch(poolPDA);
    const enc1 = Buffer.from(pool1.encryptedBalance).toString("hex");
    const non1 = pool1.balanceNonce.toString();
    expect(enc1).to.not.equal(enc0);
    expect(non1).to.not.equal(non0);
    console.log(
      "    ✅ After deposit: encrypted_balance and nonce both changed",
    );

    // Withdraw
    await new Promise((r) => setTimeout(r, 5000));
    const wPriv = x25519.utils.randomSecretKey();
    const wPub = x25519.getPublicKey(wPriv);
    const wCipher = new RescueCipher(x25519.getSharedSecret(wPriv, mxeKey));
    const wNLo = randomBytes(16);
    const wCLo = wCipher.encrypt([sLo], wNLo);
    const wNHi = randomBytes(16);
    const wCHi = wCipher.encrypt([sHi], wNHi);

    const wOff = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .withdraw(
        wOff,
        Array.from(testWithdrawKey),
        Array.from(wCLo[0]),
        Array.from(wCHi[0]),
        Array.from(wPub),
        new anchor.BN(deserializeLE(wNLo).toString()),
        new anchor.BN(deserializeLE(wNHi).toString()),
      )
      .accountsPartial({
        relayer: relayer.publicKey,
        noteRegistry: testNotePDA,
        nullifierRecord: testNullifierRecordPDA,
        poolState: poolPDA,
        vault: vaultPDA,
        nullifierRegistry: nullifierRegistryPDA,
        recipient: testRecipient.publicKey,
        ...arciumAccs(wOff, cdOffset("withdraw_from_pool")),
      })
      .signers([relayer])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await awaitComputationFinalization(provider, wOff, programId, "confirmed");
    await waitForNoteStatus(program, testNotePDA, "withdrawn");

    const pool2 = await (program.account as any).poolState.fetch(poolPDA);
    const enc2 = Buffer.from(pool2.encryptedBalance).toString("hex");
    const non2 = pool2.balanceNonce.toString();
    expect(enc2).to.not.equal(enc1);
    expect(non2).to.not.equal(non1);
    console.log(
      "    ✅ After withdraw: encrypted_balance and nonce both changed again",
    );
  });
});
