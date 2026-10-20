// The library password grants an eight-hour signed cookie without storing user sessions on a server.
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  authenticated,
  createSession,
  passwordMatches,
  setSessionCookie,
} from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import {
  HttpError,
  handleApi,
  json,
  readJson,
  requireOrigin,
} from "@/lib/server/http";

export const runtime = "nodejs";
const loginSchema = z.strictObject({ password: z.string().min(1).max(1024) });

export async function GET(request: NextRequest) {
  return handleApi(async () =>
    json({ authenticated: authenticated(request, getConfig()) }),
  );
}

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const config = getConfig();
    requireOrigin(request, config);
    const body = loginSchema.parse(await readJson(request, 4096));
    if (!passwordMatches(body.password, config))
      throw new HttpError(401, "Incorrect library password");
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
