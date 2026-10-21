// App metadata contains no video identifiers, names, keys, or viewer-specific details.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { LibraryProvider } from "@/components/library-provider";
import { VideoShell } from "@/components/video-shell";
import { getPublicDemoConfig } from "@/lib/server/public-storage";
import "./globals.css";

export const metadata: Metadata = {
  title: "EEEVP — zero-trust streaming concept",
  description:
    "Zero-trust streaming concept with browser encryption and decryption.",
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  await connection();
  const demo = getPublicDemoConfig();
  return (
    <html lang="en" className="font-sans">
      <body>
        <LibraryProvider demo={demo}>
          <VideoShell>{children}</VideoShell>
        </LibraryProvider>
      </body>
    </html>
  );
}
