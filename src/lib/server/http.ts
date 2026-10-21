// Shared request guards bound untrusted bodies and give API callers stable, sanitized failures.
import "server-only";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ConfigurationError, type ServerConfig } from "./config";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(data: object, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function handleApi(action: () => Promise<Response>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json({ error: "Invalid request" }, 400);
    if (error instanceof ConfigurationError) {
      return json({ error: "Server configuration is unavailable" }, 503);
    }
    return json({ error: "Video storage is unavailable; please retry" }, 503);
  }
}

export function requireWritableLibrary(config: ServerConfig) {
  if (config.DEMO_MODE)
    throw new HttpError(
      403,
      "This demo is read-only. Uploads and deletion are disabled.",
    );
}

export function requireOrigin(request: NextRequest, config: ServerConfig) {
  if (request.headers.get("origin") !== config.APP_ORIGIN) {
    throw new HttpError(403, "Request origin is not allowed");
  }
}

export function requireContentType(request: NextRequest, expected: string) {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== expected) throw new HttpError(415, `Expected ${expected}`);
}

export async function readBody(request: NextRequest, limit: number) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength))
      throw new HttpError(400, "Invalid content length");
    if (Number(declaredLength) > limit)
      throw new HttpError(413, "Request body is too large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJson(
  request: NextRequest,
  limit = 65536,
): Promise<unknown> {
  requireContentType(request, "application/json");
  const body = await readBody(request, limit);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
