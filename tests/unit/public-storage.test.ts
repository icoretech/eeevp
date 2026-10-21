// Runtime projection exposes the configured bucket label while keeping credential validation server-side.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "@/lib/server/config";
import {
  getPublicDemoConfig,
  getPublicStorageLabel,
} from "@/lib/server/public-storage";

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://example.com");
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv(
    "SESSION_SECRET",
    "sample-session-secret-longer-than-thirty-two-characters",
  );
});

describe("public demo configuration", () => {
  beforeEach(() => {
    vi.stubEnv("STORAGE_DRIVER", "filesystem");
    vi.stubEnv("STORAGE_PATH", "/sample/private-video-data");
  });

  it("projects no key material in private mode", () => {
    vi.stubEnv("DEMO_PUBLIC_KEY", Buffer.alloc(32, 7).toString("base64url"));

    expect(getPublicDemoConfig()).toEqual({
      demoMode: false,
      demoPublicKey: null,
    });
  });

  it("projects only the intentionally public demo key in demo mode", () => {
    const publicKey = Buffer.alloc(32, 7).toString("base64url");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DEMO_PUBLIC_KEY", publicKey);

    expect(getPublicDemoConfig()).toEqual({
      demoMode: true,
      demoPublicKey: publicKey,
    });
  });

  it("rejects demo mode without a valid public key", () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DEMO_PUBLIC_KEY", "");

    expect(() => getPublicDemoConfig()).toThrow(ConfigurationError);
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("public storage label", () => {
  it("projects only the configured fixed bucket name for S3 storage", () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_ENDPOINT", "https://storage.example.com");
    vi.stubEnv("S3_REGION", "sample-region");
    vi.stubEnv("S3_BUCKET", "sample-video-bucket");
    vi.stubEnv("S3_ACCESS_KEY_ID", "sample-access-key");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "sample-secret-key");
    vi.stubEnv("S3_FORCE_PATH_STYLE", "false");
    vi.stubEnv("S3_PREFIX", "sample-library");

    expect(getPublicStorageLabel()).toBe("sample-video-bucket");
  });

  it("labels an explicitly configured filesystem without revealing its path", () => {
    vi.stubEnv("STORAGE_DRIVER", "filesystem");
    vi.stubEnv("STORAGE_PATH", "/sample/private-video-data");

    expect(getPublicStorageLabel()).toBe("Local filesystem");
  });

  it("does not supply a label when mandatory runtime configuration is missing", () => {
    vi.stubEnv("STORAGE_DRIVER", "filesystem");
    vi.stubEnv("STORAGE_PATH", "/sample/private-video-data");
    vi.stubEnv("SESSION_SECRET", "");

    expect(() => getPublicStorageLabel()).toThrow(ConfigurationError);
  });
});
