// Opaque sessions exercise real HMAC signatures, expiry and strict runtime driver configuration.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, validSession } from "@/lib/server/auth";
import { ConfigurationError, getConfig } from "@/lib/server/config";
import { parseChunkIndex } from "@/lib/server/storage";

const environment = {
  APP_ORIGIN: "https://example.com",
  SESSION_SECRET: "sample-session-secret-for-tests-only-123456789",
  STORAGE_DRIVER: "filesystem",
  DEMO_MODE: "false",
  STORAGE_PATH: "/tmp/eeevp-test-storage",
};

function configure() {
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  return getConfig();
}

afterEach(() => vi.unstubAllEnvs());

describe("opaque library sessions", () => {
  it("accepts a signed session and rejects expired, altered and wrong-secret cookies", () => {
    const config = configure();
    const now = 1_000_000;
    const session = createSession(config, now);
    expect(validSession(session, config, now)).toBe(true);
    expect(validSession(session, config, now + 8 * 60 * 60 * 1000)).toBe(false);
    expect(
      validSession(session, { ...config, SESSION_SECRET: "a".repeat(32) }, now),
    ).toBe(false);
    expect(validSession(`x${session}`, config, now)).toBe(false);
    expect(validSession(undefined, config, now)).toBe(false);
    expect(validSession("invalid.cookie.extra", config, now)).toBe(false);
    expect(validSession("x".repeat(513), config, now)).toBe(false);
  });

  it("rejects previous session formats even when their signature is valid", () => {
    const config = configure();
    const now = 1_000_000;
    const payload = Buffer.from(
      JSON.stringify({ expiresAt: now + 1000, nonce: "sample" }),
    ).toString("base64url");
    const signature = createHmac("sha256", config.SESSION_SECRET)
      .update(payload)
      .digest("base64url");
    expect(validSession(`${payload}.${signature}`, config, now)).toBe(false);
  });
});

describe("explicit storage configuration", () => {
  it("requires an explicit demo flag and exposes a canonical public key only in demo mode", () => {
    configure();
    vi.stubEnv("DEMO_MODE", undefined);
    expect(() => getConfig()).toThrow(ConfigurationError);
    vi.stubEnv("DEMO_MODE", "1");
    expect(() => getConfig()).toThrow(ConfigurationError);
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DEMO_PUBLIC_KEY", undefined);
    expect(() => getConfig()).toThrow(ConfigurationError);
    vi.stubEnv("DEMO_PUBLIC_KEY", "d".repeat(43));
    expect(() => getConfig()).toThrow(ConfigurationError);
    const key = Buffer.alloc(32, 7).toString("base64url");
    vi.stubEnv("DEMO_PUBLIC_KEY", key);
    const demo = getConfig();
    expect(demo.DEMO_MODE).toBe(true);
    if (demo.DEMO_MODE) expect(demo.DEMO_PUBLIC_KEY).toBe(key);
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("DEMO_PUBLIC_KEY", "not-a-key");
    const privateConfig = getConfig();
    expect(privateConfig.DEMO_MODE).toBe(false);
    expect("DEMO_PUBLIC_KEY" in privateConfig).toBe(false);
  });

  it("validates required runtime values without silently selecting a driver", () => {
    configure();
    vi.stubEnv("STORAGE_PATH", "relative-path");
    expect(() => getConfig()).toThrow(ConfigurationError);
    vi.stubEnv("STORAGE_PATH", environment.STORAGE_PATH);
    vi.stubEnv("APP_ORIGIN", "https://example.com/");
    expect(() => getConfig()).toThrow("Server configuration is unavailable");
    vi.stubEnv("APP_ORIGIN", environment.APP_ORIGIN);
    vi.stubEnv("STORAGE_DRIVER", undefined);
    expect(() => getConfig()).toThrow(ConfigurationError);
  });

  it("requires all single-bucket settings and accepts only literal booleans and restricted relative prefixes", () => {
    configure();
    const settings = {
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: "https://storage.example.com",
      S3_REGION: "auto",
      S3_BUCKET: "sample-library",
      S3_ACCESS_KEY_ID: "sample-access",
      S3_SECRET_ACCESS_KEY: "sample-secret",
      S3_FORCE_PATH_STYLE: "false",
      S3_PREFIX: "library/main",
    };
    for (const [name, value] of Object.entries(settings))
      vi.stubEnv(name, value);
    const config = getConfig();
    expect(config.STORAGE_DRIVER).toBe("s3");
    if (config.STORAGE_DRIVER === "s3")
      expect(config.S3_FORCE_PATH_STYLE).toBe(false);
    vi.stubEnv("S3_FORCE_PATH_STYLE", "1");
    expect(() => getConfig()).toThrow(ConfigurationError);
    vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("S3_PREFIX", "../outside");
    expect(() => getConfig()).toThrow(ConfigurationError);
  });

  it("rejects ambiguous, negative, fractional and overflowing chunk indexes", () => {
    expect(parseChunkIndex("0")).toBe(0);
    expect(parseChunkIndex("2047")).toBe(2047);
    for (const value of ["01", "-1", "0.5", "1e2", "9007199254740992", "../0"])
      expect(() => parseChunkIndex(value)).toThrow();
  });
});
