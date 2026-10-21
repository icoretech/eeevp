"use client";

// A bounded upload worker owns plaintext encryption; this hook owns its UI state and cancellation lifetime.
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useLibrary } from "@/components/library-provider";
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
export type UploadProgress = Extract<
  z.infer<typeof uploadMessageSchema>,
  { type: "progress" }
>;
export type UploadCompletion = { id: string; name: string };

export function useVideoUpload(
  onComplete: (video: UploadCompletion) => void,
  onReset: () => void,
) {
  const { library, libraryKey, demoMode, expire, registerCleanup } =
    useLibrary();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const uploadRun = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function stop() {
      uploadRun.current += 1;
      worker.current?.terminate();
      worker.current = null;
    }
    const unregister = registerCleanup(stop);
    return () => {
      unregister();
      stop();
    };
  }, [registerCleanup]);
  const uploading = progress !== null;
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  function chooseFile(file: File | null) {
    if (demoMode) return;
    setError(null);
    onReset();
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (
      !metadataSchema.safeParse({ name: file.name, type: file.type }).success
    ) {
      setSelectedFile(null);
      setError(
        "Choose an MP4 or WebM video with a filename of up to 255 characters.",
      );
      return;
    }
    if (file.size === 0 || file.size > MAX_VIDEO_SIZE) {
      setSelectedFile(null);
      setError("Choose a video larger than 0 bytes and no larger than 2 GB.");
      return;
    }
    setSelectedFile(file);
  }

  function failUpload(message: string) {
    worker.current?.terminate();
    worker.current = null;
    setProgress(null);
    setError(message);
  }

  function start() {
    if (
      demoMode ||
      !selectedFile ||
      !library ||
      !libraryKey ||
      progress ||
      worker.current
    )
      return;
    const run = ++uploadRun.current;
    setError(null);
    onReset();
    setProgress({
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
            failUpload(
              "The encryption worker returned an invalid response. Please try again.",
            );
            return;
          }
          const message = parsed.data;
          if (message.type === "progress") {
            setProgress(message);
            return;
          }
          currentWorker.terminate();
          worker.current = null;
          setProgress(null);
          if (message.type === "error") {
            setError(message.message);
            if (message.message.includes("session expired")) expire();
            return;
          }
          if (message.video.libraryId !== library.id) {
            setError("The uploaded video did not match this library.");
            return;
          }
          setSelectedFile(null);
          if (input.current) input.current.value = "";
          onComplete({
            id: message.video.manifest.id,
            name: message.metadata.name,
          });
        },
      );
      currentWorker.addEventListener("error", () => {
        if (run === uploadRun.current)
          failUpload(
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
      failUpload(
        "This browser could not start the encryption worker. Use a current browser over HTTPS.",
      );
    }
  }

  function cancel() {
    uploadRun.current += 1;
    failUpload(
      "Upload canceled. The incomplete encrypted upload will not appear in the library.",
    );
  }
  return {
    library,
    demoMode,
    selectedFile,
    progress,
    error,
    input,
    chooseFile,
    start,
    cancel,
  };
}
