"use client";

// Header controls belong to the same authenticated, browser-unlocked library on every route.
import Link from "next/link";
import { useState } from "react";
import { useLibrary } from "@/components/library-provider";
import { Button } from "@/components/ui/button";

export function LibraryNavigation() {
  const { status, lock } = useLibrary();
  const [locking, setLocking] = useState(false);
  async function lockLibrary() {
    setLocking(true);
    try {
      await lock();
    } finally {
      setLocking(false);
    }
  }
  if (status !== "unlocked")
    return (
      <div className="header-status">
        <span className="status-dot" />
        <span>Private encrypted library</span>
      </div>
    );
  return (
    <nav className="library-navigation" aria-label="Library navigation">
      <Button
        variant="ghost"
        size="sm"
        nativeButton={false}
        render={<Link href="/" />}
      >
        Video library
      </Button>
      <Button
        variant="ghost"
        size="sm"
        nativeButton={false}
        render={<Link href="/#upload" />}
      >
        Upload
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={lockLibrary}
        disabled={locking}
      >
        {locking ? "Locking..." : "Lock library"}
      </Button>
    </nav>
  );
}
