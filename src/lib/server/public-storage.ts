// Project explicit public runtime settings; credentials and private configuration stay server-side.
import "server-only";
import { getConfig } from "./config";

export function getPublicStorageLabel() {
  const config = getConfig();
  return config.STORAGE_DRIVER === "s3" ? config.S3_BUCKET : "Local filesystem";
}

// A demo key is intentionally public; private-mode configuration never projects key material.
export function getPublicDemoConfig() {
  const config = getConfig();
  return config.DEMO_MODE
    ? { demoMode: true as const, demoPublicKey: config.DEMO_PUBLIC_KEY }
    : { demoMode: false as const, demoPublicKey: null };
}
