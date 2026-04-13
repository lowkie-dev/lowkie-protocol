import { expect } from "chai";
import {
  createFixedWindowRateLimiter,
  isAuthorized,
  isLoopbackHost,
  resolveFrontendBridgeSecurityConfig,
} from "../scripts/frontendBridgeSecurity";

describe("Frontend bridge security", () => {
  it("treats localhost bindings as loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).to.equal(true);
    expect(isLoopbackHost("localhost")).to.equal(true);
    expect(isLoopbackHost("0.0.0.0")).to.equal(false);
  });

  it("requires an auth token for public bridge deployments", () => {
    expect(() =>
      resolveFrontendBridgeSecurityConfig({
        env: {},
        host: "0.0.0.0",
        network: "devnet",
      }),
    ).to.throw("LOWKIE_API_AUTH_TOKEN");
  });

  it("requires explicit allowed origins for public bridge deployments", () => {
    expect(() =>
      resolveFrontendBridgeSecurityConfig({
        env: {
          LOWKIE_REQUIRE_API_AUTH: "true",
          LOWKIE_API_AUTH_TOKEN: "secret-token",
        },
        host: "0.0.0.0",
        network: "devnet",
      }),
    ).to.throw("LOWKIE_ALLOWED_ORIGINS");
  });

  it("validates bearer tokens when API auth is enabled", () => {
    const config = resolveFrontendBridgeSecurityConfig({
      env: {
        LOWKIE_REQUIRE_API_AUTH: "true",
        LOWKIE_API_AUTH_TOKEN: "secret-token",
        LOWKIE_ALLOWED_ORIGINS: "https://app.example.com",
      },
      host: "127.0.0.1",
      network: "devnet",
    });

    expect(isAuthorized("Bearer secret-token", config)).to.equal(true);
    expect(isAuthorized("Bearer wrong-token", config)).to.equal(false);
    expect(isAuthorized(undefined, config)).to.equal(false);
  });

  it("limits request volume per client key", () => {
    const limiter = createFixedWindowRateLimiter({
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 2,
    });

    expect(limiter("127.0.0.1", 0).allowed).to.equal(true);
    expect(limiter("127.0.0.1", 1).allowed).to.equal(true);

    const blocked = limiter("127.0.0.1", 2);
    expect(blocked.allowed).to.equal(false);
    expect(blocked.retryAfterSec).to.equal(60);
  });
});
