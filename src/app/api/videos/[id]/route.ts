// Committed encrypted records and deletion require the private library's signed session.
import type { NextRequest } from "next/server";
import { requireLibrarySession } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import {
  HttpError,
  handleApi,
  json,
  readBody,
  requireOrigin,
} from "@/lib/server/http";
import { withStorage } from "@/lib/server/storage";
import { videoIdSchema } from "@/lib/video/schema";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return handleApi(async () => {
    const config = getConfig();
    requireLibrarySession(request, config);
    const params = await context.params;
    const parsed = videoIdSchema.safeParse(params.id);
    if (!parsed.success) throw new HttpError(404, "Video not found");
    return withStorage(config, async (storage) => {
      return json({ video: await storage.readable(parsed.data) });
    });
  });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return handleApi(async () => {
    const config = getConfig();
    requireLibrarySession(request, config);
    requireOrigin(request, config);
    await readBody(request, 0);
    const params = await context.params;
    const parsed = videoIdSchema.safeParse(params.id);
    if (!parsed.success) throw new HttpError(404, "Video not found");
    return withStorage(config, async (storage) => {
      await storage.deleteVideo(parsed.data);
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    });
  });
}
