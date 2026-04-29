import dotenv from "dotenv";
dotenv.config();
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  buildRelayRequest,
  parseRelayRequest,
} from "../apps/backend/src/core/relayProtocol";

describe("Relay protocol", () => {
  it("round-trips serialized relay requests", () => {
    const request = buildRelayRequest({
      sender: "11111111111111111111111111111112",
      recipient: "11111111111111111111111111111113",
      totalLamports: 100_000_000n,
      delayMs: 15_000,
      clusterOffset: 456,
      programId: "11111111111111111111111111111114",
      rpcUrl:
        process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com",
      subNotes: [
        {
          noteSecret: new Uint8Array(
            Array.from({ length: 32 }, (_, index) => index),
          ),
          withdrawKey: new Uint8Array(
            Array.from({ length: 32 }, (_, index) => 255 - index),
          ),
          hash: Buffer.from(
            Array.from({ length: 32 }, (_, index) => index + 10),
          ),
          denominationLamports: 100_000_000n,
          amountLamports: 100_000_000n,
        },
      ],
    });

    const parsed = parseRelayRequest(request);

    expect(parsed.sender?.toBase58()).to.equal(request.sender);
    expect(parsed.recipient.toBase58()).to.equal(request.recipient);
    expect(parsed.totalLamports).to.equal(100_000_000n);
    expect(parsed.delayMs).to.equal(15_000);
    expect(parsed.clusterOffset).to.equal(456);
    expect(parsed.programId?.toBase58()).to.equal(request.programId);
    expect(parsed.rpcUrl).to.equal("https://api.devnet.solana.com");
    expect(Array.from(parsed.subNotes[0].noteSecret)).to.deep.equal(
      request.subNotes[0].noteSecret,
    );
    expect(Array.from(parsed.subNotes[0].withdrawKey)).to.deep.equal(
      request.subNotes[0].withdrawKey,
    );
    expect(Array.from(parsed.subNotes[0].hash)).to.deep.equal(
      request.subNotes[0].noteHash,
    );
  });
});
