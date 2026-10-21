// Finalization publishes one immutable manifest only after every encrypted chunk exists on the persistent volume.
import type { NextRequest } from "next/server";
import { requireLibrarySession } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import {
  HttpError,
  handleApi,
  json,
  readBody,
  requireOrigin,
  requireWritableLibrary,
} from "@/lib/server/http";
import { withStorage } from "@/lib/server/storage";
import { videoIdSchema } from "@/lib/video/schema";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return handleApi(async () => {
    const config = getConfig();
    requireWritableLibrary(config);
    await requireLibrarySession(request, config);
    requireOrigin(request, config);
    await readBody(request, 0);
    const params = await context.params;
    const parsed = videoIdSchema.safeParse(params.id);
    if (!parsed.success) throw new HttpError(404, "Video not found");
    return withStorage(config, async (storage) => {
      await storage.complete(parsed.data);
      return json({ id: parsed.data });
    });
  });
}
