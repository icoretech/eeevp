"use client";

// Permanent deletion is isolated from catalog rendering and cancels its request when the library or dialog closes.
import { useEffect, useRef, useState, useTransition } from "react";
import { useLibrary } from "@/components/library-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type CatalogVideo,
  LibrarySessionExpired,
  libraryRequest,
} from "@/lib/video/catalog";

export function DeleteVideoDialog({
  entry,
  onClose,
  onDeleted,
}: {
  entry: CatalogVideo;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const { demoMode, expire, registerCleanup } = useLibrary();
  const [pending, beginDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const actionGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    function release() {
      actionGeneration.current += 1;
      controller.abort();
    }
    const unregister = registerCleanup(release);
    return () => {
      unregister();
      release();
      if (lifetime.current === controller) lifetime.current = null;
    };
  }, [registerCleanup]);

  function remove() {
    const controller = lifetime.current;
    if (
      demoMode ||
      !entry.metadata ||
      !controller ||
      controller.signal.aborted ||
      pending
    )
      return;
    const actionId = ++actionGeneration.current;
    setError(null);
    beginDelete(async () => {
      try {
        const response = await libraryRequest(
          `/api/videos/${entry.video.manifest.id}`,
          { method: "DELETE", signal: controller.signal },
        );
        await response.body?.cancel();
        if (controller.signal.aborted || actionGeneration.current !== actionId)
          return;
        if (response.status !== 204)
          throw new Error("This video could not be deleted. Please try again.");
        onDeleted(entry.video.manifest.id);
        onClose();
      } catch (failure) {
        if (controller.signal.aborted || actionGeneration.current !== actionId)
          return;
        if (failure instanceof LibrarySessionExpired) {
          expire();
          return;
        }
        setError(
          failure instanceof Error
            ? failure.message
            : "This video could not be deleted.",
        );
      }
    });
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
          <Button
            variant="destructive"
            onClick={remove}
            disabled={pending || demoMode}
          >
            {pending ? "Deleting..." : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
