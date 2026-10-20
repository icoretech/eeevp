// Authentication contracts exercise real signatures, fixed-length password digests, and strict configuration.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  passwordMatches,
  validSession,
} from "@/lib/server/auth";
import { ConfigurationError, getConfig } from "@/lib/server/config";
import { parseChunkIndex } from "@/lib/server/storage";

const environment = {
  APP_ORIGIN: "https://example.com",
  LIBRARY_PASSWORD: "sample-upload-password",
  SESSION_SECRET: "sample-session-secret-for-tests-only-123456789",
  STORAGE_PATH: "/tmp/eeevp-test-storage",
};

function configure() {
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  return getConfig();
}

afterEach(() => vi.unstubAllEnvs());

describe("private library session signatures", () => {
  it("accepts an authentic session and rejects expired, altered and wrong-secret cookies", () => {
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

  it("checks passwords without depending on input length", () => {
    const config = configure();
    expect(passwordMatches(environment.LIBRARY_PASSWORD, config)).toBe(true);
    expect(passwordMatches("x", config)).toBe(false);
    expect(passwordMatches("", config)).toBe(false);
  });
});

describe("configuration and chunk indexes", () => {
  it("validates configuration only when requested and never exposes invalid values", () => {
    configure();
    vi.stubEnv("STORAGE_PATH", "relative-path");
    expect(() => getConfig()).toThrow(ConfigurationError);
    vi.stubEnv("STORAGE_PATH", environment.STORAGE_PATH);
    vi.stubEnv("APP_ORIGIN", "https://example.com/");
    expect(() => getConfig()).toThrow("Server configuration is unavailable");
    vi.stubEnv("APP_ORIGIN", environment.APP_ORIGIN);
    vi.stubEnv("SESSION_SECRET", "short");
    expect(() => getConfig()).toThrow(ConfigurationError);
  });

  it("rejects ambiguous, negative, fractional and overflowing chunk indexes", () => {
    expect(parseChunkIndex("0")).toBe(0);
    expect(parseChunkIndex("2047")).toBe(2047);
    for (const value of [
      "01",
      "-1",
      "0.5",
      "1e2",
      "9007199254740992",
      "../0",
    ]) {
      expect(() => parseChunkIndex(value)).toThrow();
    }
  });
});
