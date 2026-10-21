// Native WebCrypto tests protect the private library's recovery key and authenticated video-key envelopes.
import { describe, expect, it } from "vitest";
import {
  createLibraryDescriptor,
  createLibraryKey,
  unwrapVideoKey,
  verifyLibraryKey,
  wrapVideoKey,
} from "@/lib/crypto/library-crypto";
import {
  createVideo,
  decryptChunk,
  decryptMetadata,
  encryptChunk,
} from "@/lib/crypto/video-crypto";
import {
  CHUNK_SIZE,
  credentialsSchema,
  libraryDescriptorSchema,
  libraryVideoSchema,
  manifestSchema,
} from "@/lib/video/schema";

function video(size = 71) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }
  return new File([bytes], "sample-video.webm", { type: "video/webm" });
}

function corruptPacket(value: string, index: number) {
  const packet = Buffer.from(value, "base64url");
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  view.setUint8(index, view.getUint8(index) ^ 1);
  return packet.toString("base64url");
}

function packetLength(value: string) {
  return Buffer.from(value, "base64url").byteLength;
}

function shortenedPacket(value: string, length: number) {
  return Buffer.from(value, "base64url")
    .subarray(0, length)
    .toString("base64url");
}

function malformedKeys(key: string) {
  return [
    "",
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}B`,
    `${key}=`,
    ` ${key}`,
  ];
}

describe("private library recovery key", () => {
  it("generates independent canonical 32-byte keys", () => {
    const first = createLibraryKey();
    const second = createLibraryKey();

    expect(first).not.toBe(second);
    for (const key of [first, second]) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
      expect(Buffer.from(key, "base64url")).toHaveLength(32);
      expect(Buffer.from(key, "base64url").toString("base64url")).toBe(key);
    }
  });

  it("verifies the recovery key against a strict descriptor with a fresh encrypted sentinel", async () => {
    const key = createLibraryKey();
    const first = await createLibraryDescriptor(key);
    const second = await createLibraryDescriptor(key);

    expect(libraryDescriptorSchema.parse(first)).toEqual(first);
    expect(first).toEqual({
      version: 1,
      id: expect.any(String),
      encryptedVerifier: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    });
    expect(first.id).not.toBe(second.id);
    expect(first.encryptedVerifier.length).toBeLessThanOrEqual(512);
    expect(
      Buffer.from(first.encryptedVerifier, "base64url").toString("base64url"),
    ).toBe(first.encryptedVerifier);
    expect(
      Buffer.from(first.encryptedVerifier, "base64url").subarray(0, 12),
    ).not.toEqual(
      Buffer.from(second.encryptedVerifier, "base64url").subarray(0, 12),
    );
    expect(JSON.stringify(first)).not.toContain(key);
    await expect(verifyLibraryKey(first, key)).resolves.toBeUndefined();
    await expect(verifyLibraryKey(second, key)).resolves.toBeUndefined();
  });

  it("rejects a different key when checking the encrypted library verifier", async () => {
    const descriptor = await createLibraryDescriptor(createLibraryKey());

    await expect(
      verifyLibraryKey(descriptor, createLibraryKey()),
    ).rejects.toThrow();
  });

  it("rejects an authenticated verifier whose plaintext is not the fixed library marker", async () => {
    const key = createLibraryKey();
    const descriptor = await createLibraryDescriptor(key);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(Buffer.from(key, "base64url")),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const additionalData = new TextEncoder().encode(
      JSON.stringify(["EEEVP", 1, "library-verifier", descriptor.id]),
    );
    const original = Uint8Array.from(
      Buffer.from(descriptor.encryptedVerifier, "base64url"),
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: original.slice(0, 12),
        additionalData,
        tagLength: 128,
      },
      cryptoKey,
      original.slice(12),
    );
    const incorrectMarker = plaintext.slice(0);
    const view = new DataView(incorrectMarker);
    view.setUint8(0, view.getUint8(0) ^ 1);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      cryptoKey,
      incorrectMarker,
    );

    expect(
      new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData, tagLength: 128 },
          cryptoKey,
          encrypted,
        ),
      ),
    ).toEqual(new Uint8Array(incorrectMarker));
    const encryptedVerifier = Buffer.concat([
      iv,
      new Uint8Array(encrypted),
    ]).toString("base64url");
    expect(packetLength(encryptedVerifier)).toBe(original.byteLength);
    expect(
      libraryDescriptorSchema.safeParse({ ...descriptor, encryptedVerifier })
        .success,
    ).toBe(true);
    await expect(
      verifyLibraryKey({ ...descriptor, encryptedVerifier }, key),
    ).rejects.toThrow();
  });

  it("authenticates every part of the sentinel packet", async () => {
    const key = createLibraryKey();
    const descriptor = await createLibraryDescriptor(key);

    for (const index of [
      0,
      12,
      packetLength(descriptor.encryptedVerifier) - 1,
    ]) {
      await expect(
        verifyLibraryKey(
          {
            ...descriptor,
            encryptedVerifier: corruptPacket(
              descriptor.encryptedVerifier,
              index,
            ),
          },
          key,
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects truncated, extended, malformed, and oversized verifier packets", async () => {
    const key = createLibraryKey();
    const descriptor = await createLibraryDescriptor(key);
    const packet = Buffer.from(descriptor.encryptedVerifier, "base64url");

    for (const encryptedVerifier of [
      "",
      shortenedPacket(descriptor.encryptedVerifier, 12),
      shortenedPacket(descriptor.encryptedVerifier, 27),
      shortenedPacket(descriptor.encryptedVerifier, packet.byteLength - 1),
      Buffer.concat([packet, Buffer.from([0])]).toString("base64url"),
      `${descriptor.encryptedVerifier}=`,
      "A".repeat(513),
      "!".repeat(80),
    ]) {
      await expect(
        verifyLibraryKey({ ...descriptor, encryptedVerifier }, key),
      ).rejects.toThrow();
    }
  });

  it("binds the sentinel to its immutable library identity", async () => {
    const key = createLibraryKey();
    const first = await createLibraryDescriptor(key);
    const second = await createLibraryDescriptor(key);

    await expect(
      verifyLibraryKey({ ...first, id: second.id }, key),
    ).rejects.toThrow();
    await expect(
      verifyLibraryKey(
        { ...first, encryptedVerifier: second.encryptedVerifier },
        key,
      ),
    ).rejects.toThrow();
  });

  it("rejects unsupported descriptor versions, unknown fields, and invalid identities", async () => {
    const key = createLibraryKey();
    const descriptor = await createLibraryDescriptor(key);
    const unsupportedVersion = { ...descriptor };
    Reflect.set(unsupportedVersion, "version", 2);

    for (const altered of [
      unsupportedVersion,
      { ...descriptor, extra: true },
      { ...descriptor, id: "not-a-uuid" },
    ]) {
      expect(libraryDescriptorSchema.safeParse(altered).success).toBe(false);
      await expect(verifyLibraryKey(altered, key)).rejects.toThrow();
    }
  });

  it("rejects malformed recovery key encodings for creation and verification", async () => {
    const key = createLibraryKey();
    const descriptor = await createLibraryDescriptor(key);

    for (const invalid of malformedKeys(key)) {
      await expect(createLibraryDescriptor(invalid)).rejects.toThrow();
      await expect(verifyLibraryKey(descriptor, invalid)).rejects.toThrow();
    }
  });
});

describe("authenticated library video keys", () => {
  it("wraps a random video key in a canonical 60-byte envelope with a fresh IV", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(video());
    const first = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );
    const second = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );

    for (const wrapped of [first, second]) {
      expect(wrapped).toMatch(/^[A-Za-z0-9_-]{80}$/);
      expect(packetLength(wrapped)).toBe(60);
      expect(Buffer.from(wrapped, "base64url").toString("base64url")).toBe(
        wrapped,
      );
      await expect(
        unwrapVideoKey(manifest, wrapped, libraryKey, library.id),
      ).resolves.toBe(credentials.key);
    }
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url").subarray(0, 12)).not.toEqual(
      Buffer.from(second, "base64url").subarray(0, 12),
    );
  });

  it("recovers the actual key needed to authenticate metadata and multiple video chunks", async () => {
    const file = video(CHUNK_SIZE + 29);
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials, metadata } = await createVideo(file);
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );
    const recovered = await unwrapVideoKey(
      manifest,
      wrapped,
      libraryKey,
      library.id,
    );

    expect(recovered).toBe(credentials.key);
    expect(recovered).not.toBe(libraryKey);
    expect(await decryptMetadata(manifest, recovered)).toEqual(metadata);
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const plaintext = await file
        .slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
        .arrayBuffer();
      const encrypted = await encryptChunk(
        plaintext,
        index,
        manifest,
        credentials.key,
      );
      const decrypted = await decryptChunk(
        encrypted,
        index,
        manifest,
        recovered,
      );
      expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true);
    }
  });

  it("authenticates the IV, encrypted video key, and tag", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(video());
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );

    for (const index of [0, 12, 59]) {
      await expect(
        unwrapVideoKey(
          manifest,
          corruptPacket(wrapped, index),
          libraryKey,
          library.id,
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects wrong library keys and cross-library envelope substitution", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const otherLibrary = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(video());
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );

    await expect(
      unwrapVideoKey(manifest, wrapped, createLibraryKey(), library.id),
    ).rejects.toThrow();
    await expect(
      unwrapVideoKey(manifest, wrapped, libraryKey, otherLibrary.id),
    ).rejects.toThrow();
    const otherWrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      otherLibrary.id,
    );
    await expect(
      unwrapVideoKey(manifest, otherWrapped, libraryKey, library.id),
    ).rejects.toThrow();
  });

  it("binds envelopes to the complete valid manifest including encrypted metadata", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(video());
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );

    for (const altered of [
      { ...manifest, id: crypto.randomUUID() },
      { ...manifest, size: manifest.size + 1 },
      {
        ...manifest,
        encryptedMetadata: corruptPacket(manifest.encryptedMetadata, 12),
      },
    ]) {
      expect(manifestSchema.safeParse(altered).success).toBe(true);
      await expect(
        unwrapVideoKey(altered, wrapped, libraryKey, library.id),
      ).rejects.toThrow();
    }
  });

  it("rejects envelopes copied from another video in the same library", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const first = await createVideo(video());
    const second = await createVideo(video());
    const wrapped = await wrapVideoKey(
      first.manifest,
      first.credentials.key,
      libraryKey,
      library.id,
    );

    await expect(
      unwrapVideoKey(second.manifest, wrapped, libraryKey, library.id),
    ).rejects.toThrow();
  });

  it("separates library sentinel and video-key encryption domains", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(video());
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );

    await expect(
      verifyLibraryKey({ ...library, encryptedVerifier: wrapped }, libraryKey),
    ).rejects.toThrow();
    await expect(
      unwrapVideoKey(
        manifest,
        library.encryptedVerifier,
        libraryKey,
        library.id,
      ),
    ).rejects.toThrow();
  });

  it("rejects truncated, extended, and noncanonical wrapped-key packets", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(video());
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );

    for (const malformed of [
      "",
      shortenedPacket(wrapped, 12),
      shortenedPacket(wrapped, 27),
      shortenedPacket(wrapped, 59),
      `${wrapped}A`,
      `${wrapped}=`,
      "!".repeat(80),
    ]) {
      await expect(
        unwrapVideoKey(manifest, malformed, libraryKey, library.id),
      ).rejects.toThrow();
    }
  });

  it("validates both keys and library identities on wrapping and unwrapping", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(video());
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );

    for (const invalid of malformedKeys(libraryKey)) {
      await expect(
        wrapVideoKey(manifest, credentials.key, invalid, library.id),
      ).rejects.toThrow();
      await expect(
        unwrapVideoKey(manifest, wrapped, invalid, library.id),
      ).rejects.toThrow();
      await expect(
        wrapVideoKey(manifest, invalid, libraryKey, library.id),
      ).rejects.toThrow();
    }
    await expect(
      wrapVideoKey(manifest, credentials.key, libraryKey, "invalid-library"),
    ).rejects.toThrow();
    await expect(
      unwrapVideoKey(manifest, wrapped, libraryKey, "invalid-library"),
    ).rejects.toThrow();
  });

  it("validates the full manifest before either wrapping or unwrapping", async () => {
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(video());
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );
    const unsupportedVersion = { ...manifest };
    Reflect.set(unsupportedVersion, "version", 2);
    const invalidChunkSize = { ...manifest };
    Reflect.set(invalidChunkSize, "chunkSize", CHUNK_SIZE + 1);

    for (const malformed of [
      unsupportedVersion,
      invalidChunkSize,
      { ...manifest, chunkCount: manifest.chunkCount + 1 },
      { ...manifest, extra: true },
    ]) {
      await expect(
        wrapVideoKey(malformed, credentials.key, libraryKey, library.id),
      ).rejects.toThrow();
      await expect(
        unwrapVideoKey(malformed, wrapped, libraryKey, library.id),
      ).rejects.toThrow();
    }
  });

  it("keeps credentials and stored library records free of access tokens and clear metadata", async () => {
    const file = video();
    const libraryKey = createLibraryKey();
    const library = await createLibraryDescriptor(libraryKey);
    const { manifest, credentials } = await createVideo(file);
    const wrappedKey = await wrapVideoKey(
      manifest,
      credentials.key,
      libraryKey,
      library.id,
    );
    const record = libraryVideoSchema.parse({
      manifest,
      wrappedKey,
      libraryId: library.id,
      createdAt: new Date().toISOString(),
    });

    expect(Object.keys(credentials).sort()).toEqual(["id", "key"]);
    expect(
      credentialsSchema.safeParse({ ...credentials, token: createLibraryKey() })
        .success,
    ).toBe(false);
    expect(
      libraryVideoSchema.safeParse({ ...record, token: createLibraryKey() })
        .success,
    ).toBe(false);
    expect(
      libraryDescriptorSchema.safeParse({
        ...library,
        token: createLibraryKey(),
      }).success,
    ).toBe(false);
    const serialized = JSON.stringify(record);
    for (const secret of [file.name, file.type, credentials.key, libraryKey]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
