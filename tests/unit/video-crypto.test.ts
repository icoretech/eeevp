// Real Web Crypto regression tests cover the authenticated format and bounded chunk contract.
import { describe, expect, it } from "vitest";
import {
  createVideo,
  decryptChunk,
  decryptMetadata,
  encryptChunk,
} from "@/lib/crypto/video-crypto";
import {
  CHUNK_SIZE,
  credentialsSchema,
  MAX_VIDEO_SIZE,
  manifestSchema,
  metadataSchema,
} from "@/lib/video/schema";

function video(size = 48, type = "video/mp4", name = "sample-video.mp4") {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = index % 251;
  return new File([bytes], name, { type });
}

function corrupted(packet: ArrayBuffer, index: number) {
  const copy = packet.slice(0);
  const view = new DataView(copy);
  view.setUint8(index, view.getUint8(index) ^ 1);
  return copy;
}

function base64url(packet: ArrayBuffer) {
  return Buffer.from(packet).toString("base64url");
}

describe("browser video encryption", () => {
  it("creates distinct random keys and identities without exposing metadata", async () => {
    const file = video();
    const first = await createVideo(file);
    const second = await createVideo(file);

    expect(credentialsSchema.parse(first.credentials)).toEqual(
      first.credentials,
    );
    expect(Object.keys(first.credentials).sort()).toEqual(["id", "key"]);
    expect(first.credentials.key).not.toBe(second.credentials.key);
    expect(first.manifest.id).not.toBe(second.manifest.id);
    expect(first.manifest).toEqual({
      version: 1,
      id: first.credentials.id,
      size: file.size,
      chunkSize: CHUNK_SIZE,
      chunkCount: 1,
      encryptedMetadata: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    });
    expect(JSON.stringify(first.manifest)).not.toContain(file.name);
    expect(JSON.stringify(first.manifest)).not.toContain(file.type);
    expect(
      await decryptMetadata(first.manifest, first.credentials.key),
    ).toEqual(first.metadata);
  });

  it.each(["video/mp4", "video/webm"])(
    "roundtrips %s metadata and bytes using native AES-GCM",
    async (type) => {
      const file = video(
        128,
        type,
        type === "video/mp4" ? "sample.mp4" : "sample.webm",
      );
      const { manifest, credentials } = await createVideo(file);
      const plaintext = await file.arrayBuffer();
      const packet = await encryptChunk(
        plaintext,
        0,
        manifest,
        credentials.key,
      );

      expect(packet.byteLength).toBe(plaintext.byteLength + 28);
      expect(new Uint8Array(packet).slice(12, -16)).not.toEqual(
        new Uint8Array(plaintext),
      );
      expect(
        new Uint8Array(
          await decryptChunk(packet, 0, manifest, credentials.key),
        ),
      ).toEqual(new Uint8Array(plaintext));
      expect(await decryptMetadata(manifest, credentials.key)).toEqual({
        name: file.name,
        type,
      });
    },
  );

  it("uses a fresh random IV on each encryption", async () => {
    const file = video();
    const { manifest, credentials } = await createVideo(file);
    const plaintext = await file.arrayBuffer();
    const first = await encryptChunk(plaintext, 0, manifest, credentials.key);
    const second = await encryptChunk(plaintext, 0, manifest, credentials.key);

    expect(new Uint8Array(first).slice(0, 12)).not.toEqual(
      new Uint8Array(second).slice(0, 12),
    );
    expect(new Uint8Array(first)).not.toEqual(new Uint8Array(second));
    expect(
      new Uint8Array(await decryptChunk(second, 0, manifest, credentials.key)),
    ).toEqual(new Uint8Array(plaintext));
  });

  it("authenticates chunk IV, ciphertext, tag, and key", async () => {
    const file = video();
    const { manifest, credentials } = await createVideo(file);
    const packet = await encryptChunk(
      await file.arrayBuffer(),
      0,
      manifest,
      credentials.key,
    );
    const other = await createVideo(file);

    for (const index of [0, 12, packet.byteLength - 1]) {
      await expect(
        decryptChunk(corrupted(packet, index), 0, manifest, credentials.key),
      ).rejects.toThrow("authentication failed");
    }
    await expect(
      decryptChunk(packet, 0, manifest, other.credentials.key),
    ).rejects.toThrow("authentication failed");
    await expect(
      decryptMetadata(manifest, other.credentials.key),
    ).rejects.toThrow("authentication failed");
  });

  it("rejects both truncated and extended encrypted chunks before returning plaintext", async () => {
    const file = video();
    const { manifest, credentials } = await createVideo(file);
    const packet = await encryptChunk(
      await file.arrayBuffer(),
      0,
      manifest,
      credentials.key,
    );
    const extended = new Uint8Array(packet.byteLength + 1);
    extended.set(new Uint8Array(packet));

    for (const invalid of [
      new ArrayBuffer(0),
      packet.slice(0, 27),
      packet.slice(0, -1),
      extended.buffer,
    ]) {
      await expect(
        decryptChunk(invalid, 0, manifest, credentials.key),
      ).rejects.toThrow("length does not match");
    }
  });

  it("authenticates order even when chunks have identical length and content", async () => {
    const file = video(CHUNK_SIZE * 2);
    const { manifest, credentials } = await createVideo(file);
    const first = await file.slice(0, CHUNK_SIZE).arrayBuffer();
    const packet = await encryptChunk(first, 0, manifest, credentials.key);

    await expect(
      decryptChunk(packet, 1, manifest, credentials.key),
    ).rejects.toThrow("authentication failed");
  });

  it("enforces exact final-chunk length without reading the entire file", async () => {
    const file = video(CHUNK_SIZE + 31);
    const { manifest, credentials } = await createVideo(file);
    const last = await file.slice(CHUNK_SIZE).arrayBuffer();
    const packet = await encryptChunk(last, 1, manifest, credentials.key);

    expect(manifest.chunkCount).toBe(2);
    expect(packet.byteLength).toBe(59);
    expect(
      new Uint8Array(await decryptChunk(packet, 1, manifest, credentials.key)),
    ).toEqual(new Uint8Array(last));
    await expect(
      encryptChunk(new ArrayBuffer(30), 1, manifest, credentials.key),
    ).rejects.toThrow("length does not match");
    await expect(
      encryptChunk(
        new ArrayBuffer(CHUNK_SIZE + 1),
        0,
        manifest,
        credentials.key,
      ),
    ).rejects.toThrow("length does not match");
  });

  it.each([-1, 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid chunk index %s",
    async (index) => {
      const file = video();
      const { manifest, credentials } = await createVideo(file);

      await expect(
        encryptChunk(
          await file.arrayBuffer(),
          index,
          manifest,
          credentials.key,
        ),
      ).rejects.toThrow("outside the declared video");
      await expect(
        decryptChunk(
          new ArrayBuffer(file.size + 28),
          index,
          manifest,
          credentials.key,
        ),
      ).rejects.toThrow("outside the declared video");
    },
  );

  it("authenticates the manifest identity and declared size in metadata and chunks", async () => {
    const file = video(CHUNK_SIZE * 2);
    const { manifest, credentials } = await createVideo(file);
    const packet = await encryptChunk(
      await file.slice(0, CHUNK_SIZE).arrayBuffer(),
      0,
      manifest,
      credentials.key,
    );

    for (const altered of [
      { ...manifest, id: crypto.randomUUID() },
      { ...manifest, size: manifest.size - 1 },
    ]) {
      await expect(
        decryptChunk(packet, 0, altered, credentials.key),
      ).rejects.toThrow("authentication failed");
      await expect(decryptMetadata(altered, credentials.key)).rejects.toThrow(
        "authentication failed",
      );
    }
    expect(() => manifestSchema.parse({ ...manifest, version: 2 })).toThrow();
  });

  it("rejects metadata packet corruption and substitution in both metadata and chunks", async () => {
    const file = video();
    const { manifest, credentials } = await createVideo(file);
    const packet = await encryptChunk(
      await file.arrayBuffer(),
      0,
      manifest,
      credentials.key,
    );
    const metadataPacket = Buffer.from(manifest.encryptedMetadata, "base64url");
    const altered = {
      ...manifest,
      encryptedMetadata: base64url(
        corrupted(Uint8Array.from(metadataPacket).buffer, 12),
      ),
    };

    await expect(decryptMetadata(altered, credentials.key)).rejects.toThrow(
      "authentication failed",
    );
    await expect(
      decryptChunk(packet, 0, altered, credentials.key),
    ).rejects.toThrow("authentication failed");
    await expect(
      decryptMetadata(
        { ...manifest, encryptedMetadata: "A".repeat(40) },
        credentials.key,
      ),
    ).rejects.toThrow();
  });

  it("separates metadata and chunk encryption even when their packet lengths match", async () => {
    const metadata = { name: "sample.mp4", type: "video/mp4" };
    const size = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
    const file = video(size, metadata.type, metadata.name);
    const { manifest, credentials } = await createVideo(file);
    const metadataPacket = Uint8Array.from(
      Buffer.from(manifest.encryptedMetadata, "base64url"),
    ).buffer;
    const chunkPacket = await encryptChunk(
      await file.arrayBuffer(),
      0,
      manifest,
      credentials.key,
    );

    expect(metadataPacket.byteLength).toBe(chunkPacket.byteLength);
    await expect(
      decryptChunk(metadataPacket, 0, manifest, credentials.key),
    ).rejects.toThrow("authentication failed");
    await expect(
      decryptMetadata(
        { ...manifest, encryptedMetadata: base64url(chunkPacket) },
        credentials.key,
      ),
    ).rejects.toThrow("authentication failed");
  });

  it("rejects malformed key encodings in encryption and decryption", async () => {
    const file = video();
    const { manifest, credentials } = await createVideo(file);
    const plaintext = await file.arrayBuffer();
    const packet = await encryptChunk(plaintext, 0, manifest, credentials.key);
    for (const key of [
      "",
      "A".repeat(42),
      "B".repeat(43),
      `${credentials.key}=`,
    ]) {
      await expect(encryptChunk(plaintext, 0, manifest, key)).rejects.toThrow();
      await expect(decryptChunk(packet, 0, manifest, key)).rejects.toThrow();
      await expect(decryptMetadata(manifest, key)).rejects.toThrow();
    }
  });

  it("rejects invalid videos and schemas before encryption", async () => {
    await expect(createVideo(video(0))).rejects.toThrow("larger than 0");
    await expect(createVideo(video(1, "text/plain"))).rejects.toThrow();
    await expect(createVideo(video(1, "video/mp4", ""))).rejects.toThrow();
    await expect(
      createVideo(video(1, "video/mp4", "invalid\nname.mp4")),
    ).rejects.toThrow();

    const { manifest, credentials } = await createVideo(video());
    for (const altered of [
      { ...manifest, size: 0 },
      { ...manifest, size: MAX_VIDEO_SIZE + 1 },
      { ...manifest, size: 1.5 },
      { ...manifest, size: Number.POSITIVE_INFINITY },
      { ...manifest, chunkSize: CHUNK_SIZE + 1 },
      { ...manifest, chunkCount: 2 },
      { ...manifest, encryptedMetadata: "A".repeat(2_049) },
      { ...manifest, extra: true },
    ]) {
      expect(manifestSchema.safeParse(altered).success).toBe(false);
    }
    expect(
      metadataSchema.safeParse({
        name: "sample.mp4",
        type: "video/mp4",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      credentialsSchema.safeParse({ ...credentials, key: "A".repeat(42) })
        .success,
    ).toBe(false);
    expect(
      credentialsSchema.safeParse({
        ...credentials,
        key: `${"A".repeat(42)}B`,
      }).success,
    ).toBe(false);
    expect(
      credentialsSchema.safeParse({
        ...credentials,
        key: `${credentials.key}=`,
      }).success,
    ).toBe(false);
  });

  it("accepts the exact upper size bound without allocating the video", async () => {
    const file = new File(["x"], "large.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", {
      value: MAX_VIDEO_SIZE,
      configurable: true,
    });
    const { manifest } = await createVideo(file);
    expect(manifest.size).toBe(MAX_VIDEO_SIZE);
    expect(manifest.chunkCount).toBe(2_048);

    Object.defineProperty(file, "size", {
      value: MAX_VIDEO_SIZE + 1,
      configurable: true,
    });
    await expect(createVideo(file)).rejects.toThrow("no larger than 2 GiB");
  });
});
