// Shared server-rendered framing gives the library and private player one visual language.
import Link from "next/link";
import type { ReactNode } from "react";
import { LibraryNavigation } from "@/components/library-navigation";

export function VideoGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 48"
      fill="none"
      className={className}
    >
      <rect
        x="9"
        y="8"
        width="30"
        height="32"
        rx="5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="m21 18 10 6-10 6V18Z" fill="currentColor" />
      <path
        d="M9 15h5m-5 9h5m-5 9h5m20-18h5m-5 9h5m-5 9h5"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export function LockGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <path
        d="M7 10V7a5 5 0 0 1 10 0v3"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <rect x="4" y="10" width="16" height="11" rx="3" fill="currentColor" />
      <path
        d="M12 14v3"
        stroke="var(--background)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function VideoShell({
  children,
  player = false,
}: {
  children: ReactNode;
  player?: boolean;
}) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link href="/" className="brand" aria-label="EEEVP home">
          <span className="brand-symbol" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-wordmark">
            EEEVP<span className="brand-dot">.</span>
          </span>
        </Link>
        <span className="header-divider" aria-hidden="true" />
        <span className="brand-label">Private video library</span>
        <LibraryNavigation />
      </header>
      <main className={player ? "main-content player-content" : "main-content"}>
        {children}
      </main>
      <footer className="app-footer">
        <span>encrypted end-to-end video player</span>
        <span>
          your browser holds the key<span aria-hidden="true"> ↗</span>
        </span>
      </footer>
    </div>
  );
}
