"use client";

// The library lists authenticated server records and coordinates bounded browser encryption, uploads, and deletion.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useLibrary } from "@/components/library-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { LockGlyph, VideoGlyph } from "@/components/video-shell";
import {
  type CatalogVideo,
  fetchLibraryCatalog,
  LibrarySessionExpired,
  libraryRequest,
} from "@/lib/video/catalog";
import {
  libraryVideoSchema,
  MAX_VIDEO_SIZE,
  metadataSchema,
} from "@/lib/video/schema";

const uploadMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("progress"),
    phase: z.enum(["encrypting", "uploading", "completing"]),
    completed: z.number().nonnegative(),
    total: z.number().positive(),
  }),
  z.strictObject({
    type: z.literal("complete"),
    video: libraryVideoSchema,
    metadata: metadataSchema,
  }),
  z.strictObject({ type: z.literal("error"), message: z.string() }),
]);
type UploadProgress = Extract<
  z.infer<typeof uploadMessageSchema>,
  { type: "progress" }
>;

function fileSize(bytes: number) {
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}
function uploadLabel(progress: UploadProgress) {
  if (progress.phase === "encrypting") return "Encrypting in your browser";
  if (progress.phase === "completing") return "Verifying encrypted upload";
  return "Uploading encrypted chunks";
}

function DeleteVideoDialog({
  entry,
  onClose,
  onDeleted,
  onExpired,
}: {
  entry: CatalogVideo;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onExpired: () => void;
}) {
  const { registerCleanup } = useLibrary();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const unregister = registerCleanup(() => controller.abort());
    return () => {
      unregister();
      controller.abort();
      if (lifetime.current === controller) lifetime.current = null;
    };
  }, [registerCleanup]);
  async function remove() {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await libraryRequest(
        `/api/videos/${entry.video.manifest.id}`,
        { method: "DELETE", signal: controller.signal },
      );
      await response.body?.cancel();
      if (controller.signal.aborted || lifetime.current !== controller) return;
      if (response.status !== 204)
        throw new Error("This video could not be deleted. Please try again.");
      onDeleted(entry.video.manifest.id);
      onClose();
    } catch (failure) {
      if (controller.signal.aborted || lifetime.current !== controller) return;
      if (failure instanceof LibrarySessionExpired) {
        onExpired();
        return;
      }
      setError(
        failure instanceof Error
          ? failure.message
          : "This video could not be deleted.",
      );
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Delete video permanently?</DialogTitle>
          <DialogDescription>
            {entry.metadata?.name ?? "This encrypted video"} will be removed
            from your private library and storage. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Deletion failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Keep video
          </Button>
          <Button variant="destructive" onClick={remove} disabled={pending}>
            {pending ? "Deleting..." : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VideoLibrary() {
  const { library, libraryKey, expire, registerCleanup } = useLibrary();
  const [videos, setVideos] = useState<CatalogVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<CatalogVideo | null>(null);
  const request = useRef<AbortController | null>(null);
  const worker = useRef<Worker | null>(null);
  const uploadRun = useRef(0);
  const uploadInput = useRef<HTMLInputElement>(null);

  // The callback is an Effect dependency: a stable identity keeps catalog synchronization tied to this unlocked library.
  const refreshCatalog = useCallback(async () => {
    if (!library || !libraryKey) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setCatalogError(null);
    try {
      const items = await fetchLibraryCatalog(
        libraryKey,
        library.id,
        controller.signal,
      );
      if (!controller.signal.aborted) setVideos(items);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof LibrarySessionExpired) {
        expire();
        return;
      }
      setCatalogError(
        failure instanceof Error
          ? failure.message
          : "Your video library could not be loaded.",
      );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [library, libraryKey, expire]);

  useEffect(() => {
    void refreshCatalog();
    return () => request.current?.abort();
  }, [refreshCatalog]);
  useEffect(() => {
    function stop() {
      uploadRun.current += 1;
      worker.current?.terminate();
      worker.current = null;
      request.current?.abort();
    }
    const unregister = registerCleanup(stop);
    return () => {
      unregister();
      stop();
    };
  }, [registerCleanup]);
  const uploading = upload !== null;
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  function chooseFile(file: File | null) {
    setUploadError(null);
    setCompleted(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (
      !metadataSchema.safeParse({ name: file.name, type: file.type }).success
    ) {
      setSelectedFile(null);
      setUploadError(
        "Choose an MP4 or WebM video with a filename of up to 255 characters.",
      );
      return;
    }
    if (file.size === 0 || file.size > MAX_VIDEO_SIZE) {
      setSelectedFile(null);
      setUploadError(
        "Choose a video larger than 0 bytes and no larger than 2 GB.",
      );
      return;
    }
    setSelectedFile(file);
  }

  function startUpload() {
    if (!selectedFile || !library || !libraryKey || upload || worker.current)
      return;
    const run = ++uploadRun.current;
    setUploadError(null);
    setCompleted(null);
    setUpload({
      type: "progress",
      phase: "encrypting",
      completed: 0,
      total: selectedFile.size,
    });
    try {
      const currentWorker = new Worker(
        new URL("../workers/upload-worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.current = currentWorker;
      currentWorker.addEventListener(
        "message",
        (event: MessageEvent<unknown>) => {
          if (run !== uploadRun.current) return;
          const parsed = uploadMessageSchema.safeParse(event.data);
          if (!parsed.success) {
            currentWorker.terminate();
            worker.current = null;
            setUpload(null);
            setUploadError(
              "The encryption worker returned an invalid response. Please try again.",
            );
            return;
          }
          const message = parsed.data;
          if (message.type === "progress") {
            setUpload(message);
            return;
          }
          currentWorker.terminate();
          worker.current = null;
          setUpload(null);
          if (message.type === "error") {
            setUploadError(message.message);
            if (message.message.includes("session expired")) expire();
            return;
          }
          if (message.video.libraryId !== library.id) {
            setUploadError("The uploaded video did not match this library.");
            return;
          }
          setCompleted({
            id: message.video.manifest.id,
            name: message.metadata.name,
          });
          setSelectedFile(null);
          if (uploadInput.current) uploadInput.current.value = "";
          void refreshCatalog();
        },
      );
      currentWorker.addEventListener("error", () => {
        if (run !== uploadRun.current) return;
        currentWorker.terminate();
        worker.current = null;
        setUpload(null);
        setUploadError(
          "The encryption worker stopped. Please try the upload again.",
        );
      });
      currentWorker.postMessage({
        type: "upload",
        file: selectedFile,
        libraryKey,
        library,
      });
    } catch {
      worker.current?.terminate();
      worker.current = null;
      setUpload(null);
      setUploadError(
        "This browser could not start the encryption worker. Use a current browser over HTTPS.",
      );
    }
  }
  function cancelUpload() {
    uploadRun.current += 1;
    worker.current?.terminate();
    worker.current = null;
    setUpload(null);
    setUploadError(
      "Upload canceled. The incomplete encrypted upload will not appear in the library.",
    );
  }

  const filteredVideos = videos.filter(
    (entry) =>
      !query.trim() ||
      entry.metadata?.name
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const percent = upload
    ? Math.min(100, Math.round((upload.completed / upload.total) * 100))
    : 0;
  const totalSize = videos.reduce(
    (sum, entry) => sum + entry.video.manifest.size,
    0,
  );

  return (
    <>
      <section className="private-library-heading">
        <div>
          <p className="eyebrow">YOUR PRIVATE VIDEO LIBRARY</p>
          <h1>
            Video library<span>.</span>
          </h1>
          <p>Your videos, encrypted in storage. Opened only in your browser.</p>
        </div>
        <div className="library-heading-meta">
          <Badge variant="secondary">Library unlocked</Badge>
          <span>
            {videos.length} {videos.length === 1 ? "video" : "videos"}
            {videos.length > 0 ? ` · ${fileSize(totalSize)}` : ""}
          </span>
        </div>
      </section>
      <div className="workspace-grid private-workspace-grid">
        <section className="library-section" aria-labelledby="library-heading">
          <div className="section-header">
            <h2 id="library-heading">All videos</h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshCatalog()}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh library"}
            </Button>
          </div>
          <Field className="library-search">
            <FieldLabel className="sr-only" htmlFor="video-search">
              Search videos
            </FieldLabel>
            <Input
              id="video-search"
              type="search"
              placeholder="Search videos by filename"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </Field>
          {catalogError && (
            <Alert variant="destructive" className="mb-5">
              <AlertTitle>Library could not refresh</AlertTitle>
              <AlertDescription>
                {catalogError} Existing results are kept below.
              </AlertDescription>
            </Alert>
          )}
          {loading && videos.length === 0 ? (
            <div
              className="catalog-grid"
              role="status"
              aria-label="Loading encrypted video library"
            >
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : videos.length === 0 && !catalogError ? (
            <Empty className="library-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <VideoGlyph />
                </EmptyMedia>
                <EmptyTitle>
                  Your library is ready for its first video.
                </EmptyTitle>
                <EmptyDescription>
                  Upload a video to keep it in your private library. Its key and
                  filename are encrypted before storage.
                </EmptyDescription>
              </EmptyHeader>
              <div className="empty-file-label">
                <span>MP4</span>
                <span aria-hidden="true">/</span>
                <span>WEBM</span>
                <span aria-hidden="true">·</span>
                <span>UP TO 2 GB</span>
              </div>
            </Empty>
          ) : filteredVideos.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No matching videos</EmptyTitle>
                <EmptyDescription>Try a different filename.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="catalog-grid">
              {filteredVideos.map((entry) => (
                <Card key={entry.video.manifest.id} className="catalog-card">
                  <div className="catalog-art" aria-hidden="true">
                    <VideoGlyph />
                    <span>
                      {entry.metadata
                        ? entry.metadata.type === "video/mp4"
                          ? "MP4"
                          : "WEBM"
                        : "ENCRYPTED VIDEO"}
                    </span>
                  </div>
                  <CardHeader>
                    <CardTitle title={entry.metadata?.name}>
                      {entry.metadata?.name ?? "Encrypted video unavailable"}
                    </CardTitle>
                    <CardDescription>
                      {fileSize(entry.video.manifest.size)}
                      <span aria-hidden="true"> · </span>
                      {new Date(entry.video.createdAt).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric", year: "numeric" },
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {entry.error ? (
                      <p className="field-error">{entry.error}</p>
                    ) : (
                      <Badge variant="outline">End-to-end encrypted</Badge>
                    )}
                  </CardContent>
                  <CardFooter>
                    {entry.metadata ? (
                      <Button
                        size="sm"
                        nativeButton={false}
                        render={
                          <Link href={`/watch/${entry.video.manifest.id}`} />
                        }
                      >
                        Watch video<span aria-hidden="true">↗</span>
                      </Button>
                    ) : (
                      <Button size="sm" disabled>
                        Cannot decrypt
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleting(entry)}
                      aria-label={`Delete ${entry.metadata?.name ?? "encrypted video"}`}
                    >
                      Delete
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
          <div className="library-footnote">
            <LockGlyph />
            <p>
              The library key stays in browser memory. Locking or reloading
              clears it; use your saved key to unlock again.
            </p>
          </div>
        </section>
        <aside
          className="upload-section"
          id="upload"
          aria-labelledby="upload-heading"
        >
          <Card className="upload-card">
            <CardHeader>
              <div className="upload-card-top">
                <span className="eyebrow">ADD TO YOUR LIBRARY</span>
                <Badge variant="outline">Private</Badge>
              </div>
              <CardTitle id="upload-heading">Upload a video.</CardTitle>
              <CardDescription>
                Your browser encrypts the original and its filename before
                upload.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-5">
                <FieldGroup>
                  <Field data-disabled={uploading}>
                    <FieldLabel htmlFor="video-file">
                      Choose your video
                    </FieldLabel>
                    <Input
                      ref={uploadInput}
                      id="video-file"
                      type="file"
                      accept="video/mp4,video/webm"
                      disabled={uploading}
                      onChange={(event) =>
                        chooseFile(event.currentTarget.files?.item(0) ?? null)
                      }
                    />
                    <FieldDescription>
                      MP4 or WebM, up to 2 GB. No transcoding.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
                {selectedFile && !upload && (
                  <div className="selected-file">
                    <VideoGlyph />
                    <div>
                      <strong>{selectedFile.name}</strong>
                      <span>
                        {fileSize(selectedFile.size)} · ready to encrypt
                      </span>
                    </div>
                  </div>
                )}
                {upload ? (
                  <div
                    className="upload-progress"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="progress-caption">
                      <span>{uploadLabel(upload)}</span>
                      <span>{percent}%</span>
                    </div>
                    <Progress
                      value={percent}
                      aria-label="Encrypted upload progress"
                    />
                    <p>
                      {fileSize(upload.completed)} of {fileSize(upload.total)} ·
                      keep this tab open
                    </p>
                    {upload.phase !== "completing" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={cancelUpload}
                      >
                        Cancel upload
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    className="w-full"
                    disabled={!selectedFile}
                    onClick={startUpload}
                  >
                    Encrypt & upload<span aria-hidden="true">↗</span>
                  </Button>
                )}
              </div>
              {uploadError && (
                <Alert variant="destructive" className="mt-5">
                  <AlertTitle>Upload needs attention</AlertTitle>
                  <AlertDescription>{uploadError}</AlertDescription>
                </Alert>
              )}
              {completed && (
                <Alert className="mt-5">
                  <AlertTitle>Video added to your library</AlertTitle>
                  <AlertDescription>
                    {completed.name}
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/watch/${completed.id}`} />}
                    >
                      Watch video
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
            <CardFooter>
              <div className="upload-security-note">
                <LockGlyph />
                <span>
                  AES-256-GCM encryption
                  <br />
                  Protected by your library key
                </span>
              </div>
            </CardFooter>
          </Card>
        </aside>
      </div>
      {deleting && (
        <DeleteVideoDialog
          key={deleting.video.manifest.id}
          entry={deleting}
          onClose={() => setDeleting(null)}
          onExpired={expire}
          onDeleted={(id) => {
            setVideos((items) =>
              items.filter((entry) => entry.video.manifest.id !== id),
            );
            setCompleted((value) => (value?.id === id ? null : value));
            void refreshCatalog();
          }}
        />
      )}
    </>
  );
}
