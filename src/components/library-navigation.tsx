"use client";

// Header actions explain demo restrictions and move private uploads to an accessible, focused section.
import { LockIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useLibrary } from "@/components/library-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

function DemoUploadNotice() {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        Upload
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Read-only demo</DialogTitle>
          <DialogDescription>
            Uploads are disabled in this public demo. You can browse and play
            the sample videos.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button />}>Continue browsing</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PrivateUploadLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      nativeButton={false}
      render={
        <Link
          href="/#upload"
          onNavigate={(event) => {
            if (window.location.pathname !== "/") return;
            const section = document.getElementById("upload");
            if (!(section instanceof HTMLElement)) return;
            event.preventDefault();
            section.focus({ preventScroll: true });
            section.scrollIntoView({
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? "instant"
                : "smooth",
              block: "center",
            });
          }}
        />
      }
    >
      Upload
    </Button>
  );
}

export function LibraryNavigation() {
  const { status, demoMode, lock } = useLibrary();
  const pathname = usePathname();
  const [locking, setLocking] = useState(false);
  async function lockLibrary() {
    setLocking(true);
    try {
      await lock();
    } finally {
      setLocking(false);
    }
  }
  if (status !== "open") return null;
  return (
    <nav className="library-navigation" aria-label="Library navigation">
      <Button
        variant="ghost"
        size="sm"
        nativeButton={false}
        render={
          <Link
            href="/"
            aria-current={pathname === "/" ? "page" : undefined}
            prefetch={pathname === "/" ? false : null}
            transitionTypes={["nav-back"]}
            onNavigate={(event) => {
              if (pathname === "/") event.preventDefault();
            }}
          />
        }
      >
        Video library
      </Button>
      {demoMode ? <DemoUploadNotice /> : <PrivateUploadLink />}
      <Button
        variant="outline"
        size="sm"
        onClick={lockLibrary}
        disabled={locking}
      >
        <LockIcon data-icon="inline-start" />
        {locking ? "Locking..." : "Lock library"}
      </Button>
    </nav>
  );
}
