// Immutable, bounded object IO for one server-configured S3-compatible bucket.
import "server-only";
import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { ObjectStore, S3StoreConfig } from "./object-store";

function validateKey(key: string, prefix = false) {
  const value = prefix && key.endsWith("/") ? key.slice(0, -1) : key;
  if (prefix && key === "") return;
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid object key");
  }
}

function missing(error: unknown) {
  return (
    error instanceof S3ServiceException &&
    (error.name === "NoSuchKey" || error.name === "NotFound")
  );
}

function checkedSize(size: number | undefined) {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0)
    throw new Error("Invalid object size");
  return size;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: S3StoreConfig) {
    validateKey(config.prefix);
    this.bucket = config.bucket;
    this.prefix = `${config.prefix}/`;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Retrying an ambiguous conditional PUT can turn our own success into 412.
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  private key(key: string) {
    validateKey(key);
    return this.prefix + key;
  }

  async read(key: string, limit: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error("Invalid read limit");
    const controller = new AbortController();
    const abortSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => {
      void reader?.cancel(abortSignal.reason).catch(() => {});
    };
    abortSignal.addEventListener("abort", cancelReader, { once: true });
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
        { abortSignal },
      );
      if (!result.Body) throw new Error("Missing object body");
      // The SDK exposes the actual response stream without collecting it first.
      reader = result.Body.transformToWebStream().getReader();
      abortSignal.throwIfAborted();
      if (
        result.ContentLength !== undefined &&
        checkedSize(result.ContentLength) > limit
      )
        throw new Error("Object exceeds read limit");
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        abortSignal.throwIfAborted();
        const chunk = await reader.read();
        abortSignal.throwIfAborted();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) throw new Error("Object exceeds read limit");
        chunks.push(Buffer.from(chunk.value));
      }
      if (result.ContentLength !== undefined && length !== result.ContentLength)
        throw new Error("Object length mismatch");
      return Buffer.concat(chunks, length);
    } catch (error) {
      controller.abort();
      if (reader) await reader.cancel().catch(() => {});
      if (missing(error)) return null;
      throw error;
    } finally {
      abortSignal.removeEventListener("abort", cancelReader);
      reader?.releaseLock();
    }
  }

  async publish(key: string, body: string | Uint8Array) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          Body: body,
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 412
      )
        return false;
      // 409 and transport failures are indeterminate, never permission to overwrite.
      throw error;
    }
  }

  async head(key: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
        { abortSignal: signal },
      );
      signal?.throwIfAborted();
      return { size: checkedSize(result.ContentLength) };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async list(prefix: string) {
    validateKey(prefix, true);
    const keys: string[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix + prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key?.startsWith(this.prefix + prefix))
          throw new Error("Invalid listed object key");
        const key = object.Key.slice(this.prefix.length);
        validateKey(key);
        keys.push(key);
      }
      if (!page.IsTruncated) break;
      token = page.NextContinuationToken;
      if (!token || tokens.has(token))
        throw new Error("Invalid object listing continuation");
      tokens.add(token);
    } while (token);
    return keys;
  }

  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
    );
  }

  async ready() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    const key = `health/${randomUUID()}`;
    const payload = randomUUID();
    // Do not clean up an unknown PUT outcome: it might still commit later.
    if (!(await this.publish(key, payload)))
      throw new Error("Storage probe collision");
    try {
      if ((await this.read(key, 64))?.toString() !== payload)
        throw new Error("Storage probe failed");
    } finally {
      await this.remove(key);
    }
  }
}
