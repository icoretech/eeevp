"use client";

// The workspace composes canonical catalog browsing, bounded uploads, and permanent deletion without owning their lifecycles.
import { useState } from "react";
import { useLibrary } from "@/components/library-provider";
import { WorkspaceSection } from "@/components/page-transitions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { VideoCatalog } from "@/components/video-catalog";
import { DeleteVideoDialog } from "@/components/video-delete-dialog";
import { VideoUpload } from "@/components/video-upload";
import { useVideoCatalog } from "@/hooks/use-video-catalog";
import type { UploadCompletion } from "@/hooks/use-video-upload";
import type { CatalogVideo } from "@/lib/video/catalog";
import { formatVideoSize } from "@/lib/video/format";

export function VideoLibrary() {
  const { demoMode, error: sessionError, retryLibrary } = useLibrary();
  const catalog = useVideoCatalog();
  const [completed, setCompleted] = useState<UploadCompletion | null>(null);
  const [deleting, setDeleting] = useState<CatalogVideo | null>(null);
  const totalSize = catalog.videos.reduce(
    (sum, entry) => sum + entry.video.manifest.size,
    0,
  );

  function requestDelete(entry: CatalogVideo) {
    if (!demoMode && entry.metadata) setDeleting(entry);
  }

  function uploaded(video: UploadCompletion) {
    setCompleted(video);
    void catalog.refresh();
  }
  function deleted(id: string) {
    catalog.remove(id);
    setCompleted((video) => (video?.id === id ? null : video));
    void catalog.refresh();
  }

  return (
    <>
      <WorkspaceSection area="heading">
        <section className="private-library-heading">
          <div>
            <h1>
              Video library<span>.</span>
            </h1>
          </div>
          <div className="library-heading-meta">
            <Badge variant="secondary">Library open</Badge>
            <span>
              {catalog.videos.length}{" "}
              {catalog.videos.length === 1 ? "video" : "videos"}
              {catalog.videos.length > 0
                ? ` · ${formatVideoSize(totalSize)}`
                : ""}
            </span>
          </div>
        </section>
      </WorkspaceSection>
      {sessionError && !catalog.error && (
        <Alert variant="destructive" className="mb-5">
          <AlertTitle>Library unavailable</AlertTitle>
          <AlertDescription>{sessionError}</AlertDescription>
        </Alert>
      )}
      <WorkspaceSection area="panels">
        <div className="workspace-grid private-workspace-grid">
          <VideoCatalog
            videos={catalog.videos}
            loading={catalog.loading}
            error={catalog.error}
            onRefresh={() =>
              void (sessionError ? retryLibrary() : catalog.refresh())
            }
            onDelete={requestDelete}
          />
          <VideoUpload
            key={demoMode ? "demo" : "private"}
            completed={completed}
            onComplete={uploaded}
            onReset={() => setCompleted(null)}
          />
        </div>
      </WorkspaceSection>
      {deleting && (
        <DeleteVideoDialog
          key={deleting.video.manifest.id}
          entry={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={deleted}
        />
      )}
    </>
  );
}
