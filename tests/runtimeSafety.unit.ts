import { expect } from "chai";
import { assertRuntimeSafety } from "../client/runtimeSafety";

describe("Runtime safety guards", () => {
  it("rejects auto-compaction without explicit unsafe local approval", () => {
    expect(() =>
      assertRuntimeSafety(
        {
          LOWKIE_AUTO_COMPACT_REGISTRY: "true",
        },
        "localnet",
      ),
    ).to.throw("LOWKIE_ALLOW_UNSAFE_LOCALNET");
  });

  it("rejects auto-compaction on non-local networks", () => {
    expect(() =>
      assertRuntimeSafety(
        {
          LOWKIE_AUTO_COMPACT_REGISTRY: "true",
          LOWKIE_ALLOW_UNSAFE_LOCALNET: "true",
        },
        "devnet",
      ),
    ).to.throw("only supported on localnet");
  });

  it("rejects plaintext note export without the explicit allow flag", () => {
    expect(() =>
      assertRuntimeSafety(
        {
          LOWKIE_WRITE_NOTE_FILE: "true",
        },
        "localnet",
      ),
    ).to.throw("LOWKIE_ALLOW_PLAINTEXT_NOTE_FILE");
  });

  it("allows safe non-local defaults", () => {
    const config = assertRuntimeSafety({}, "devnet");
    expect(config.autoCompactRegistry).to.equal(false);
    expect(config.writePlaintextNoteFile).to.equal(false);
  });
});
