// Recovery files and entered keys are normalized locally without checking access or sending a key to the server.
import { credentialsSchema } from "@/lib/video/schema";

const encoder = new TextEncoder();
const RECOVERY_HEADER = "EEEVP library recovery key";
const MAX_FILE_BYTES = 8_192;
const MAX_KEY_CHARACTERS = 4_096;

export function serializeLibraryKeyRecovery(key: string): string {
  const parsed = credentialsSchema.shape.key.parse(key);
  return [
    RECOVERY_HEADER,
    parsed,
    "",
    "Keep this key private and safe. It decrypts your EEEVP library.",
    "Import this file when opening your library on another device or after reloading.",
    "Existing videos always need the key used to encrypt them.",
    "",
  ].join("\n");
}

export function normalizeLibraryKeyInput(input: string): string {
  if (input.length > MAX_FILE_BYTES)
    throw new Error("The encryption key or recovery file is too large.");
  const text = input.trim();
  if (
    !text.includes("\n") &&
    !text.includes("\r") &&
    text !== RECOVERY_HEADER
  ) {
    if (text.length > MAX_KEY_CHARACTERS)
      throw new Error("The encryption key is too long.");
    return text;
  }
  if (encoder.encode(input).byteLength > MAX_FILE_BYTES)
    throw new Error("The recovery file is too large.");
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines[0] !== RECOVERY_HEADER ||
    lines.filter((line) => line === RECOVERY_HEADER).length !== 1
  ) {
    throw new Error(
      "Choose a valid EEEVP recovery file or enter your encryption key.",
    );
  }
  const keys = lines.filter(
    (line) => credentialsSchema.shape.key.safeParse(line).success,
  );
  const key = keys[0];
  if (keys.length !== 1 || !key || lines[1] !== key) {
    throw new Error(
      "The recovery file must contain exactly one encryption key.",
    );
  }
  return key;
}
