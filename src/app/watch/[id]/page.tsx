// The opaque route id contains no secret; authenticated browser playback requires the unlocked library.
import { notFound } from "next/navigation";
import { LibraryGate } from "@/components/library-gate";
import { VideoShell } from "@/components/video-shell";
import { VideoWatch } from "@/components/video-watch";
import { videoIdSchema } from "@/lib/video/schema";

export default async function WatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!videoIdSchema.safeParse(id).success) notFound();
  return (
    <VideoShell player>
      <LibraryGate>
        <VideoWatch key={id} id={id} />
      </LibraryGate>
    </VideoShell>
  );
}
