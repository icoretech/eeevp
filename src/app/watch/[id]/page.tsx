// The opaque route id contains no secret; authenticated browser playback requires the unlocked library.
import { notFound } from "next/navigation";
import { LibraryGate } from "@/components/library-gate";
import { PageTransition } from "@/components/page-transitions";
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
    <PageTransition key={id}>
      <LibraryGate>
        <VideoWatch key={id} id={id} />
      </LibraryGate>
    </PageTransition>
  );
}
