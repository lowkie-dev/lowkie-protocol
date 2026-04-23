import { expect } from "chai";
import os from "node:os";
import path from "node:path";
import {
  expandHomePath,
  resolveOptionalPathFromEnv,
  resolvePathFromEnv,
} from "../apps/backend/src/core/utils";

describe("Runtime path helpers", () => {
  it("expands home-directory shorthand", () => {
    expect(expandHomePath("~/wallets/id.json")).to.equal(
      path.join(os.homedir(), "wallets/id.json"),
    );
  });

  it("resolves configured env paths before fallback", () => {
    expect(
      resolvePathFromEnv("ANCHOR_WALLET", "~/.config/solana/id.json", {
        ANCHOR_WALLET: "~/custom/admin.json",
      }),
    ).to.equal(path.join(os.homedir(), "custom/admin.json"));
  });

  it("returns undefined for missing optional env paths", () => {
    expect(resolveOptionalPathFromEnv("RELAYER_KEYPAIR_PATH", {})).to.equal(
      undefined,
    );
  });
});