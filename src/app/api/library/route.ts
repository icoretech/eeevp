// The immutable encrypted verifier identifies one private library without receiving its browser key.
import type { NextRequest } from "next/server";
import { requireLibrarySession } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import { handleApi, json, readJson, requireOrigin } from "@/lib/server/http";
import { withStorage } from "@/lib/server/storage";
import { libraryDescriptorSchema } from "@/lib/video/schema";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return handleApi(async () => {
    const config = getConfig();
    requireLibrarySession(request, config);
    return withStorage(config, async (storage) =>
      json({ library: await storage.library() }),
    );
  });
}

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const config = getConfig();
    requireLibrarySession(request, config);
    requireOrigin(request, config);
    const descriptor = libraryDescriptorSchema.parse(
      await readJson(request, 4096),
    );
    return withStorage(config, async (storage) =>
      json({ library: await storage.createLibrary(descriptor) }, 201),
    );
  });
}
