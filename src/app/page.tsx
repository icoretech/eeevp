// The shell gates the authenticated private catalog behind a browser-only library key.
import { LibraryGate } from "@/components/library-gate";
import { VideoLibrary } from "@/components/video-library";
import { VideoShell } from "@/components/video-shell";

export default function Home() {
  return (
    <VideoShell>
      <LibraryGate>
        <VideoLibrary />
      </LibraryGate>
    </VideoShell>
  );
}
