// The shell gates the authenticated private catalog behind a browser-only library key.
import { LibraryGate } from "@/components/library-gate";
import { PageTransition } from "@/components/page-transitions";
import { VideoLibrary } from "@/components/video-library";

export default function Home() {
  return (
    <PageTransition key="library">
      <LibraryGate>
        <VideoLibrary />
      </LibraryGate>
    </PageTransition>
  );
}
