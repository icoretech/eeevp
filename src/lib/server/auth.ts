// Private library access uses signed HttpOnly cookies; browser decryption keys never enter sessions.
import "server-only";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import type { ServerConfig } from "./config";
import { HttpError } from "./http";

export const SESSION_COOKIE = "eeevp-session";
const SESSION_SECONDS = 60 * 60 * 8;

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function passwordMatches(password: string, config: ServerConfig) {
  return timingSafeEqual(digest(password), digest(config.LIBRARY_PASSWORD));
}

export function createSession(config: ServerConfig, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({
      expiresAt: now + SESSION_SECONDS * 1000,
      nonce: randomBytes(16).toString("base64url"),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", config.SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function validSession(
  value: string | undefined,
  config: ServerConfig,
  now = Date.now(),
) {
  if (!value || value.length > 512) return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (
    !payload ||
    !signature ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  ) {
    return false;
  }
  const received = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", config.SESSION_SECRET)
    .update(payload)
    .digest();
  if (
    received.toString("base64url") !== signature ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    return false;
  try {
    const record: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      typeof record !== "object" ||
      record === null ||
      !("expiresAt" in record)
    )
      return false;
    return (
      typeof record.expiresAt === "number" &&
      Number.isSafeInteger(record.expiresAt) &&
      record.expiresAt > now &&
      record.expiresAt <= now + SESSION_SECONDS * 1000
    );
  } catch {
    return false;
  }
}

export function authenticated(request: NextRequest, config: ServerConfig) {
  return validSession(request.cookies.get(SESSION_COOKIE)?.value, config);
}

export function requireLibrarySession(
  request: NextRequest,
  config: ServerConfig,
) {
  if (!authenticated(request, config))
    throw new HttpError(401, "Library sign-in required");
}

export function setSessionCookie(
  response: NextResponse,
  config: ServerConfig,
  value: string,
) {
  response.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: new URL(config.APP_ORIGIN).protocol === "https:",
    sameSite: "strict",
    path: "/",
    maxAge: value ? SESSION_SECONDS : 0,
  });
}
