// Ciphertext chunks are immutable, length-checked objects; neither route ever receives a browser key.
import type { NextRequest } from "next/server";
import { requireLibrarySession } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import {
  HttpError,
  handleApi,
  readBody,
  requireContentType,
  requireOrigin,
} from "@/lib/server/http";
import {
  expectedChunkLength,
  parseChunkIndex,
  withStorage,
} from "@/lib/server/storage";
import { videoIdSchema } from "@/lib/video/schema";

export const runtime = "nodejs";
type ChunkContext = { params: Promise<{ id: string; index: string }> };

async function parseParams(context: ChunkContext) {
  const params = await context.params;
  const parsed = videoIdSchema.safeParse(params.id);
  if (!parsed.success) throw new HttpError(404, "Video not found");
  return { id: parsed.data, index: parseChunkIndex(params.index) };
}

export async function PUT(request: NextRequest, context: ChunkContext) {
  return handleApi(async () => {
    const config = getConfig();
    requireLibrarySession(request, config);
    requireOrigin(request, config);
    requireContentType(request, "application/octet-stream");
    const { id, index } = await parseParams(context);
    return withStorage(config, async (storage) => {
      const draft = await storage.draft(id);
      const packet = await readBody(
        request,
        expectedChunkLength(draft.manifest, index),
      );
      await storage.putChunk(id, index, packet);
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    });
  });
}

export async function GET(request: NextRequest, context: ChunkContext) {
  return handleApi(async () => {
    const config = getConfig();
    requireLibrarySession(request, config);
    const { id, index } = await parseParams(context);
    return withStorage(config, async (storage) => {
      const packet = await storage.readChunk(id, index);
      return new Response(new Uint8Array(packet), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(packet.byteLength),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  });
}
