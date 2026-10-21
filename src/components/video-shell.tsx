// Shared server-rendered framing gives the library and private player one visual language.
import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { LibraryNavigation } from "@/components/library-navigation";
import { MotionMain } from "@/components/page-transitions";
import { GitHubGlyph, XGlyph } from "@/components/video-glyphs";
import { getPublicStorageLabel } from "@/lib/server/public-storage";

export async function VideoShell({ children }: { children: ReactNode }) {
  await connection();
  const storageLabel = getPublicStorageLabel();
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link
          href="/"
          transitionTypes={["nav-back"]}
          className="brand"
          aria-label="EEEVP home"
        >
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
        <span className="brand-label">Zero-trust streaming concept</span>
        <div className="header-storage" title={storageLabel}>
          <span className="status-dot" aria-hidden="true" />
          <span className="storage-label">{storageLabel}</span>
        </div>
        <LibraryNavigation />
      </header>
      <MotionMain>{children}</MotionMain>
      <footer className="app-footer">
        <div className="footer-brand">
          <span className="footer-wordmark">
            EEEVP<span aria-hidden="true">.</span>
          </span>
          <p>Encrypted End-to-End Video Player</p>
        </div>
        <nav className="footer-links" aria-label="EEEVP social links">
          <Link
            href="https://github.com/icoretech"
            target="_blank"
            rel="noopener noreferrer"
          >
            <GitHubGlyph />
            icoretech
          </Link>
          <Link
            href="https://x.com/icoretech_inc"
            target="_blank"
            rel="noopener noreferrer"
          >
            <XGlyph />
            @icoretech_inc
          </Link>
        </nav>
      </footer>
    </div>
  );
}
