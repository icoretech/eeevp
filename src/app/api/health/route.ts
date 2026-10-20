// Readiness verifies that the persistent storage directory can write and sync a real file.
import { getConfig } from "@/lib/server/config";
import { handleApi, json } from "@/lib/server/http";
import { withStorage } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleApi(async () =>
    withStorage(getConfig(), async (storage) => {
      await storage.ready();
      return json({ ready: true });
    }),
  );
}
