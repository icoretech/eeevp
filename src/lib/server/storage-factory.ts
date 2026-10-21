// Runtime selection is explicit: development files or exactly one configured S3-compatible bucket.
import "server-only";
import { createHash } from "node:crypto";
import type { ServerConfig } from "./config";
import { FilesystemObjectStore } from "./filesystem-object-store";
import { S3ObjectStore } from "./r2-object-store";

let cachedS3: { signature: string; store: S3ObjectStore } | undefined;

export function createObjectStore(config: ServerConfig) {
  if (config.STORAGE_DRIVER === "filesystem")
    return new FilesystemObjectStore(config.STORAGE_PATH);
  const settings = {
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    prefix: config.S3_PREFIX,
  };
  const signature = createHash("sha256")
    .update(JSON.stringify(settings))
    .digest("hex");
  if (cachedS3?.signature === signature) return cachedS3.store;
  const store = new S3ObjectStore(settings);
  // Cache connection pools only; every catalog, record and tombstone is still read from shared storage.
  cachedS3 = { signature, store };
  return store;
}
