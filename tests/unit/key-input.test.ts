// Recovery-file parsing stays local and preserves entered text without checking library access.
import { describe, expect, it } from "vitest";
import {
  normalizeLibraryKeyInput,
  serializeLibraryKeyRecovery,
} from "@/lib/crypto/key-input";
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

function recoveryFile(key: string) {
  return [
    "EEEVP library recovery key",
    "",
    key,
    "",
    "Keep this key private and safe. It decrypts your EEEVP library.",
    "Enter it after signing in on another device or after reloading.",
    "Your library password cannot replace this key.",
    "",
  ].join("\n");
}

describe("local encryption-key input normalization", () => {
  it("trims pasted keys, leading BOMs, and surrounding whitespace without changing the key", () => {
    const key = createLibraryKey();

    for (const input of [
      key,
      ` \t${key}\r\n `,
      `\uFEFF${key}`,
      `\uFEFF \r\n${key}\r\n`,
    ]) {
      expect(normalizeLibraryKeyInput(input)).toBe(key);
    }
  });

  it("imports the existing downloaded recovery file with all explanatory notes", () => {
    const key = createLibraryKey();
    const file = recoveryFile(key);

    expect(normalizeLibraryKeyInput(file)).toBe(key);
    expect(
      normalizeLibraryKeyInput(`\uFEFF${file.replaceAll("\n", "\r\n")}`),
    ).toBe(key);
    expect(
      normalizeLibraryKeyInput(`EEEVP library recovery key\n\n${key}\n`),
    ).toBe(key);
  });

  it("preserves plain nonempty text without imposing AES key syntax", () => {
    for (const input of [
      "incorrect key",
      "B".repeat(43),
      "key=not_base64url!",
      "caf\u00E9 \u{1F511}",
    ]) {
      expect(normalizeLibraryKeyInput(` ${input} `)).toBe(input);
    }
  });

  it("leaves empty normalized input for form validation", () => {
    for (const input of ["", " ", "\t\r\n", "\uFEFF \r\n"]) {
      expect(normalizeLibraryKeyInput(input)).toBe("");
    }
  });

  it("accepts exactly 4096 plain characters and rejects larger input", () => {
    expect(normalizeLibraryKeyInput("x".repeat(4096))).toBe("x".repeat(4096));
    expect(() => normalizeLibraryKeyInput("x".repeat(4097))).toThrow();
  });

  it("accepts an 8 KiB recovery file and rejects even one extra byte", () => {
    const key = createLibraryKey();
    const file = recoveryFile(key);
    const bounded = file + "x".repeat(8192 - Buffer.byteLength(file, "utf8"));

    expect(Buffer.byteLength(bounded, "utf8")).toBe(8192);
    expect(normalizeLibraryKeyInput(bounded)).toBe(key);
    expect(() => normalizeLibraryKeyInput(`${bounded}x`)).toThrow();
  });

  it("applies the recovery-file bound to UTF-8 bytes", () => {
    const file = recoveryFile(createLibraryKey()) + "\u00E9".repeat(4096);

    expect(file.length).toBeLessThan(8192);
    expect(Buffer.byteLength(file, "utf8")).toBeGreaterThan(8192);
    expect(() => normalizeLibraryKeyInput(file)).toThrow();
  });

  it("rejects duplicate key lines even when they contain the same key", () => {
    const key = createLibraryKey();
    for (const other of [key, createLibraryKey()]) {
      expect(() =>
        normalizeLibraryKeyInput(`${recoveryFile(key)}\n${other}\n`),
      ).toThrow();
    }
  });

  it("rejects missing or misplaced keys instead of extracting a later candidate", () => {
    const key = createLibraryKey();
    for (const input of [
      "EEEVP library recovery key\n\n",
      "EEEVP library recovery key\n\nNo key was saved.\n",
      `EEEVP library recovery key\n\nInstructions before the key.\n${key}\n`,
      `EEEVP library recovery key\n\n${"B".repeat(43)}\n`,
    ]) {
      expect(() => normalizeLibraryKeyInput(input)).toThrow();
    }
  });

  it("rejects multiline content without the exact recovery-file header", () => {
    const key = createLibraryKey();
    for (const input of [
      `EEEVP recovery key\n\n${key}\n`,
      `eeevp library recovery key\n\n${key}\n`,
      `Unrecognized file\n\n${key}\n`,
      `${key}\nAn explanatory note\n`,
      `Prefix\n${recoveryFile(key)}`,
    ]) {
      expect(() => normalizeLibraryKeyInput(input)).toThrow();
    }
  });
});

describe("local recovery-file generation", () => {
  it("writes the generated key on the second line and imports the exact same key", () => {
    const key = createLibraryKey();
    const serialized = serializeLibraryKeyRecovery(key);
    const lines = serialized.split(/\r\n|\r|\n/);

    expect(lines.slice(0, 2)).toEqual(["EEEVP library recovery key", key]);
    expect(lines.filter((line) => line === key)).toHaveLength(1);
    expect(lines.slice(2).join("\n").trim().length).toBeGreaterThan(0);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8192);
    expect(normalizeLibraryKeyInput(serialized)).toBe(key);
    expect(
      normalizeLibraryKeyInput(`\uFEFF${serialized.replaceAll("\n", "\r\n")}`),
    ).toBe(key);
  });

  it("recovers the key that decrypts real library envelopes, metadata, and video bytes", async () => {
    const key = createLibraryKey();
    const library = await createLibraryDescriptor(key);
    const recovered = normalizeLibraryKeyInput(
      serializeLibraryKeyRecovery(key),
    );
    const file = new File([Uint8Array.of(1, 2, 3, 4, 5)], "sample.webm", {
      type: "video/webm",
    });
    const { manifest, credentials, metadata } = await createVideo(file);
    const wrapped = await wrapVideoKey(
      manifest,
      credentials.key,
      key,
      library.id,
    );
    const recoveredVideoKey = await unwrapVideoKey(
      manifest,
      wrapped,
      recovered,
      library.id,
    );
    const plaintext = await file.arrayBuffer();
    const encrypted = await encryptChunk(
      plaintext,
      0,
      manifest,
      credentials.key,
    );

    await expect(verifyLibraryKey(library, recovered)).resolves.toBeUndefined();
    expect(recoveredVideoKey).toBe(credentials.key);
    expect(await decryptMetadata(manifest, recoveredVideoKey)).toEqual(
      metadata,
    );
    const decrypted = await decryptChunk(
      encrypted,
      0,
      manifest,
      recoveredVideoKey,
    );
    expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true);
  });

  it("rejects malformed or noncanonical keys when writing a recovery file", () => {
    const key = createLibraryKey();

    for (const malformed of [
      "",
      "incorrect key",
      "A".repeat(42),
      "A".repeat(44),
      "B".repeat(43),
      `${key}=`,
      ` ${key}`,
      `${key}\n`,
      recoveryFile(key),
    ]) {
      expect(() => serializeLibraryKeyRecovery(malformed)).toThrow();
    }
  });
});
