import { expect } from "chai";
import {
  buildCorsHeaders,
  createFixedWindowRateLimiter,
  isAuthorized,
  isLoopbackHost,
  resolveApiSecurityConfig,
} from "../apps/backend/lib/security";

describe("Frontend bridge security", () => {
  it("treats localhost bindings as loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).to.equal(true);
    expect(isLoopbackHost("localhost")).to.equal(true);
    expect(isLoopbackHost("0.0.0.0")).to.equal(false);
  });

  it("requires an auth token for public bridge deployments", () => {
    expect(() =>
      resolveApiSecurityConfig({
        env: {},
        host: "0.0.0.0",
        network: "devnet",
      }),
    ).to.throw("LOWKIE_API_AUTH_TOKEN");
  });

  it("defaults to an unsafe local bridge on loopback hosts", () => {
    const config = resolveApiSecurityConfig({
      env: {},
      host: "127.0.0.1",
      network: "localnet",
    });

    expect(config.allowUnsafeLocalBridge).to.equal(true);
    expect(config.requireApiAuth).to.equal(false);
  });

  it("allows an explicit unsafe local bridge only on loopback hosts", () => {
    const config = resolveApiSecurityConfig({
      env: {
        LOWKIE_ALLOW_UNSAFE_LOCAL_BRIDGE: "true",
      },
      host: "127.0.0.1",
      network: "localnet",
    });

    expect(config.allowUnsafeLocalBridge).to.equal(true);
    expect(config.requireApiAuth).to.equal(false);
  });

  it("rejects unsafe local bridge mode on non-loopback hosts", () => {
    expect(() =>
      resolveApiSecurityConfig({
        env: {
          LOWKIE_ALLOW_UNSAFE_LOCAL_BRIDGE: "true",
        },
        host: "0.0.0.0",
        network: "devnet",
      }),
    ).to.throw("LOWKIE_ALLOW_UNSAFE_LOCAL_BRIDGE");
  });

  it("requires explicit allowed origins for public bridge deployments", () => {
    expect(() =>
      resolveApiSecurityConfig({
        env: {
          LOWKIE_REQUIRE_API_AUTH: "true",
          LOWKIE_API_AUTH_TOKEN: "super-secret-token-123",
        },
        host: "0.0.0.0",
        network: "devnet",
      }),
    ).to.throw("LOWKIE_ALLOWED_ORIGINS");
  });

  it("validates bearer tokens when API auth is enabled", () => {
    const config = resolveApiSecurityConfig({
      env: {
        LOWKIE_REQUIRE_API_AUTH: "true",
        LOWKIE_API_AUTH_TOKEN: "super-secret-token-123",
        LOWKIE_ALLOWED_ORIGINS: "https://app.example.com",
      },
      host: "127.0.0.1",
      network: "devnet",
    });

    expect(isAuthorized("Bearer super-secret-token-123", config)).to.equal(true);
    expect(isAuthorized("Bearer wrong-token", config)).to.equal(false);
    expect(isAuthorized(undefined, config)).to.equal(false);
  });

  it("rejects placeholder auth tokens when auth is enabled", () => {
    expect(() =>
      resolveApiSecurityConfig({
        env: {
          LOWKIE_REQUIRE_API_AUTH: "true",
          LOWKIE_API_AUTH_TOKEN: "replace-me",
          LOWKIE_ALLOWED_ORIGINS: "https://app.example.com",
        },
        host: "0.0.0.0",
        network: "devnet",
      }),
    ).to.throw("production secret");
  });

  it("rejects short auth tokens when auth is enabled", () => {
    expect(() =>
      resolveApiSecurityConfig({
        env: {
          LOWKIE_REQUIRE_API_AUTH: "true",
          LOWKIE_API_AUTH_TOKEN: "short-token",
          LOWKIE_ALLOWED_ORIGINS: "https://app.example.com",
        },
        host: "0.0.0.0",
        network: "devnet",
      }),
    ).to.throw("at least 16 characters");
  });

  it("does not emit wildcard CORS headers when no origins are configured", () => {
    const headers = buildCorsHeaders("https://app.example.com", []);

    expect(headers["Access-Control-Allow-Origin"]).to.equal(undefined);
  });

  it("only enables proxy-header trust when explicitly configured", () => {
    const defaultConfig = resolveApiSecurityConfig({
      env: {
        LOWKIE_API_AUTH_TOKEN: "super-secret-token-123",
      },
      host: "127.0.0.1",
      network: "localnet",
    });
    const trustedConfig = resolveApiSecurityConfig({
      env: {
        LOWKIE_API_AUTH_TOKEN: "super-secret-token-123",
        LOWKIE_TRUST_PROXY_HEADERS: "true",
      },
      host: "127.0.0.1",
      network: "localnet",
    });

    expect(defaultConfig.trustProxyHeaders).to.equal(false);
    expect(trustedConfig.trustProxyHeaders).to.equal(true);
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
