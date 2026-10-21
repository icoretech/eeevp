"use client";

// The canonical catalog owns local filename search while retaining opaque rows whose metadata cannot be decrypted.
import Link from "next/link";
import { useDeferredValue, useState } from "react";
import { useLibrary } from "@/components/library-provider";
import { CatalogTransition } from "@/components/page-transitions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LockGlyph, VideoGlyph } from "@/components/video-glyphs";
import type { CatalogVideo } from "@/lib/video/catalog";
import { formatVideoDate, formatVideoSize } from "@/lib/video/format";

function VideoCard({
  entry,
  onDelete,
  readOnly,
}: {
  entry: CatalogVideo;
  readOnly: boolean;
  onDelete: (entry: CatalogVideo) => void;
}) {
  const title =
    entry.metadata?.name ??
    `${entry.video.manifest.encryptedMetadata.slice(0, 56)}...`;

  return (
    <Card className="catalog-card">
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
        <CardTitle title={title}>{title}</CardTitle>
        <CardAction>
          <Badge variant="outline">
            {entry.metadata ? "End-to-end encrypted" : "Encrypted metadata"}
          </Badge>
        </CardAction>
        <CardDescription>
          {formatVideoSize(entry.video.manifest.size)}
          <span aria-hidden="true"> · </span>
          <time dateTime={entry.video.createdAt}>
            {formatVideoDate(entry.video.createdAt)}
          </time>
        </CardDescription>
      </CardHeader>
      <CardFooter>
        {entry.metadata ? (
          <Button
            size="sm"
            nativeButton={false}
            render={
              <Link
                href={`/watch/${entry.video.manifest.id}`}
                transitionTypes={["nav-forward"]}
              />
            }
          >
            Watch video<span aria-hidden="true">↗</span>
          </Button>
        ) : (
          <Button size="sm" disabled>
            Watch video
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (!readOnly && entry.metadata) onDelete(entry);
          }}
          disabled={readOnly || !entry.metadata}
          aria-label={`Delete ${entry.metadata?.name ?? "encrypted video"}`}
        >
          Delete
        </Button>
      </CardFooter>
    </Card>
  );
}

export function VideoCatalog({
  videos,
  loading,
  error,
  onRefresh,
  onDelete,
}: {
  videos: CatalogVideo[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onDelete: (entry: CatalogVideo) => void;
}) {
  const { demoMode } = useLibrary();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim().toLocaleLowerCase();
  const filteredVideos = videos.filter(
    (entry) =>
      !deferredQuery ||
      (entry.metadata?.name ?? entry.video.manifest.encryptedMetadata)
        .toLocaleLowerCase()
        .includes(deferredQuery),
  );

  return (
    <section className="library-section" aria-labelledby="library-heading">
      <div className="section-header">
        <h2 id="library-heading">All videos</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
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
      {error && (
        <Alert variant="destructive" className="mb-5">
          <AlertTitle>Library could not refresh</AlertTitle>
          <AlertDescription>
            {error} Existing results are kept below.
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
      ) : videos.length === 0 && !error ? (
        <Empty className="library-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <VideoGlyph />
            </EmptyMedia>
            <EmptyTitle>Your library is ready for its first video.</EmptyTitle>
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
            <CatalogTransition
              key={entry.video.manifest.id}
              id={entry.video.manifest.id}
            >
              <VideoCard
                entry={entry}
                readOnly={demoMode}
                onDelete={onDelete}
              />
            </CatalogTransition>
          ))}
        </div>
      )}
      <div className="library-footnote">
        <LockGlyph />
        <p>
          {demoMode
            ? "Read-only demo. The prefilled key is public; videos decrypt in your browser."
            : "The encryption key stays in browser memory. Locking or reloading clears it. Log in again with the same key."}
        </p>
      </div>
    </section>
  );
}
