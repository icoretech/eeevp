// The browser opens an opaque session without submitting its local encryption key or proving key ownership.
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  authenticated,
  createSession,
  setSessionCookie,
} from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import { handleApi, json, readJson, requireOrigin } from "@/lib/server/http";

export const runtime = "nodejs";
const sessionSchema = z.strictObject({});

export async function GET(request: NextRequest) {
  return handleApi(async () =>
    json({ authenticated: authenticated(request, getConfig()) }),
  );
}

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const config = getConfig();
    requireOrigin(request, config);
    sessionSchema.parse(await readJson(request, 4096));
    const response = json({ authenticated: true });
    setSessionCookie(response, config, createSession(config));
    return response;
  });
}

export async function DELETE(request: NextRequest) {
  return handleApi(async () => {
    const config = getConfig();
    requireOrigin(request, config);
    const response = json({ authenticated: false });
    setSessionCookie(response, config, "");
    return response;
  });
}
