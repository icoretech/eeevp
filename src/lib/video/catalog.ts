// The session-backed server catalog is canonical; names and per-video keys are opened only in the browser.
import { z } from "zod";
import { unwrapVideoKey } from "@/lib/crypto/library-crypto";
import { decryptMetadata } from "@/lib/crypto/video-crypto";
import { type LibraryVideo, libraryVideoSchema } from "@/lib/video/schema";

export class LibrarySessionExpired extends Error {
  constructor() {
    super("Your library session expired. Enter your encryption key again.");
  }
}

export async function libraryRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    mode: "same-origin",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new LibrarySessionExpired();
  }
  return response;
}

export async function openLibraryVideo(
  video: LibraryVideo,
  key: string,
  libraryId: string | null,
) {
  if (libraryId !== null && video.libraryId !== libraryId)
    throw new Error("This video belongs to a different encrypted library.");
  const videoKey = await unwrapVideoKey(
    video.manifest,
    video.wrappedKey,
    key,
    video.libraryId,
  );
  const metadata = await decryptMetadata(video.manifest, videoKey);
  return { metadata, credentials: { id: video.manifest.id, key: videoKey } };
}

const catalogSchema = z.strictObject({ videos: z.array(libraryVideoSchema) });
export async function fetchLibraryCatalog(
  key: string,
  libraryId: string | null,
  signal: AbortSignal,
) {
  const response = await libraryRequest("/api/videos", { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("The video library could not be loaded. Please try again.");
  }
  const result = catalogSchema.safeParse(await response.json());
  if (!result.success)
    throw new Error("The server returned invalid library records.");
  return Promise.all(
    result.data.videos.map(async (video) => {
      try {
        const { metadata } = await openLibraryVideo(video, key, libraryId);
        return { video, metadata, error: null };
      } catch {
        return {
          video,
          metadata: null,
          error: "This video's encrypted metadata could not be opened.",
        };
      }
    }),
  );
}

export type CatalogVideo = Awaited<
  ReturnType<typeof fetchLibraryCatalog>
>[number];
