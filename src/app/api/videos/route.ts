// The private catalog stores encrypted metadata and browser-wrapped keys, never clear video keys.
import type { NextRequest } from "next/server";
import { requireLibrarySession } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import {
  handleApi,
  json,
  readJson,
  requireOrigin,
  requireWritableLibrary,
} from "@/lib/server/http";
import { withStorage } from "@/lib/server/storage";
import { libraryVideoSchema } from "@/lib/video/schema";

export const runtime = "nodejs";

const draftSchema = libraryVideoSchema.omit({ createdAt: true });

export async function GET(request: NextRequest) {
  return handleApi(async () => {
    const config = getConfig();
    await requireLibrarySession(request, config);
    return withStorage(config, async (storage) =>
      json({ videos: await storage.list() }),
    );
  });
}

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const config = getConfig();
    requireWritableLibrary(config);
    await requireLibrarySession(request, config);
    requireOrigin(request, config);
    const body = draftSchema.parse(await readJson(request));
    return withStorage(config, async (storage) => {
      await storage.createDraft(body.manifest, body.wrappedKey, body.libraryId);
      return json({ id: body.manifest.id }, 201);
    });
  });
}
