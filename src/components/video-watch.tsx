"use client";

// Authenticated playback unwraps one video key with the in-memory library key and streams decrypted chunks locally.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useLibrary } from "@/components/library-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LockGlyph, VideoGlyph } from "@/components/video-shell";
import {
  LibrarySessionExpired,
  libraryRequest,
  openLibraryVideo,
} from "@/lib/video/catalog";
import { openPlayback, PlaybackSessionExpired } from "@/lib/video/playback";
import { libraryVideoSchema, type VideoMetadata } from "@/lib/video/schema";

const videoResponseSchema = z.strictObject({ video: libraryVideoSchema });
type WatchState =
  | { status: "opening" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string; metadata: VideoMetadata };

export function VideoWatch({ id }: { id: string }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <VideoPlayback
      key={`${id}-${attempt}`}
      id={id}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

function VideoPlayback({ id, onRetry }: { id: string; onRetry: () => void }) {
  const { library, libraryKey, expire, registerCleanup } = useLibrary();
  const [state, setState] = useState<WatchState>({ status: "opening" });
  const stopPlayback = useRef<(() => void) | null>(null);
  const mediaRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!library || !libraryKey) return;
    generation.current += 1;
    const activeLibrary = library;
    const activeKey = libraryKey;
    const controller = new AbortController();
    let playback: Awaited<ReturnType<typeof openPlayback>> | null = null;
    let onDisconnect: (() => void) | null = null;
    function stop() {
      if (playback && onDisconnect)
        playback.disconnected.removeEventListener("abort", onDisconnect);
      controller.abort();
      playback?.close();
    }
    function release() {
      generation.current += 1;
      mediaRequest.current?.abort();
      stop();
    }
    stopPlayback.current = stop;
    const unregister = registerCleanup(release);
    async function open() {
      try {
        const response = await libraryRequest(`/api/videos/${id}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            response.status === 404
              ? "This video is no longer in your library."
              : "This encrypted video could not be loaded. Please try again.",
          );
        }
        const result = videoResponseSchema.safeParse(await response.json());
        if (!result.success || result.data.video.manifest.id !== id)
          throw new Error("The encrypted video details are invalid.");
        const opened = await openLibraryVideo(
          result.data.video,
          activeKey,
          activeLibrary.id,
        );
        if (controller.signal.aborted) return;
        const media = document.createElement("video");
        if (!media.canPlayType(opened.metadata.type))
          throw new Error(
            "This browser does not support the video format. Try a current browser that supports MP4 and WebM.",
          );
        playback = await openPlayback(
          result.data.video.manifest,
          opened.credentials,
          opened.metadata,
          controller.signal,
        );
        if (controller.signal.aborted) {
          playback.close();
          return;
        }
        onDisconnect = () => {
          if (controller.signal.aborted) return;
          const reason: unknown = playback?.disconnected.reason;
          if (reason instanceof PlaybackSessionExpired) {
            expire();
            return;
          }
          setState({
            status: "error",
            message:
              reason instanceof Error
                ? reason.message
                : "The secure playback worker restarted. Open the video again.",
          });
          stop();
        };
        playback.disconnected.addEventListener("abort", onDisconnect, {
          once: true,
        });
        if (playback.disconnected.aborted) {
          onDisconnect();
          return;
        }
        setState({
          status: "ready",
          url: playback.url,
          metadata: opened.metadata,
        });
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (
          failure instanceof LibrarySessionExpired ||
          failure instanceof PlaybackSessionExpired
        ) {
          expire();
          return;
        }
        setState({
          status: "error",
          message:
            failure instanceof Error
              ? failure.message
              : "The video could not be decrypted. Its encrypted data may have changed.",
        });
        stop();
      }
    }
    void open();
    return () => {
      unregister();
      release();
      if (stopPlayback.current === stop) stopPlayback.current = null;
    };
  }, [id, library, libraryKey, expire, registerCleanup]);

  async function handleMediaError() {
    const requestGeneration = generation.current;
    mediaRequest.current?.abort();
    const controller = new AbortController();
    mediaRequest.current = controller;
    stopPlayback.current?.();
    setState({
      status: "error",
      message:
        "Playback stopped. The connection, video codec, or encrypted data could not be read. Open the video again; if it still fails, upload a supported MP4 or WebM.",
    });
    try {
      const response = await libraryRequest(`/api/videos/${id}`, {
        signal: controller.signal,
      });
      await response.body?.cancel();
    } catch (failure) {
      if (controller.signal.aborted || requestGeneration !== generation.current)
        return;
      if (failure instanceof LibrarySessionExpired) expire();
    } finally {
      if (mediaRequest.current === controller) mediaRequest.current = null;
    }
  }

  return (
    <>
      <div className="player-toolbar">
        <Button variant="ghost" nativeButton={false} render={<Link href="/" />}>
          <span aria-hidden="true">←</span>Video library
        </Button>
        <Badge variant="outline">PRIVATE PLAYBACK</Badge>
      </div>
      <section aria-label="Private video player" className="player-section">
        <div className="player-heading">
          <p className="eyebrow">DECRYPTED HERE. PLAYED HERE.</p>
          <h1>
            {state.status === "ready"
              ? state.metadata.name
              : "Your private video."}
          </h1>
          <p>
            Your library key stays in this browser. The server delivers
            encrypted chunks.
          </p>
        </div>
        <div
          className={`video-stage${state.status === "ready" ? " video-stage-ready" : ""}`}
        >
          {state.status === "ready" ? (
            // biome-ignore lint/a11y/useMediaCaption: Uploaded originals have no separate caption asset; the native player retains available embedded tracks.
            <video
              key={state.url}
              src={state.url}
              controls
              playsInline
              preload="metadata"
              aria-label={state.metadata.name}
              onError={handleMediaError}
            />
          ) : state.status === "opening" ? (
            <div className="player-placeholder" role="status">
              <div className="player-lock">
                <LockGlyph />
              </div>
              <h2>Opening your video</h2>
              <p>
                Unlocking the encrypted video and preparing browser playback...
              </p>
              <span className="opening-indicator" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
          ) : (
            <div className="player-placeholder player-error">
              <VideoGlyph />
              <h2>This video could not be opened.</h2>
              <p>{state.message}</p>
              <Button onClick={onRetry}>
                Open video again<span aria-hidden="true">↗</span>
              </Button>
            </div>
          )}
        </div>
        <div className="player-caption">
          <div>
            <LockGlyph />
            <span>
              End-to-end encrypted
              <span className="caption-divider" aria-hidden="true">
                {" "}
                /{" "}
              </span>
              <span className="caption-detail">Private library</span>
            </span>
          </div>
          <span>
            {state.status === "ready"
              ? `${state.metadata.type === "video/mp4" ? "MP4" : "WEBM"} · ORIGINAL QUALITY`
              : "YOUR LIBRARY KEY STAYS IN THE BROWSER"}
          </span>
        </div>
      </section>
      <Alert className="viewer-note">
        <AlertTitle>Your library stays private</AlertTitle>
        <AlertDescription>
          Videos require your authenticated session and browser-held library
          key. Lock the library when you finish watching.
        </AlertDescription>
      </Alert>
    </>
  );
}
