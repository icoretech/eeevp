// App metadata contains no video identifiers, names, keys, or viewer-specific details.

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LibraryProvider } from "@/components/library-provider";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "EEEVP — private video library",
  description:
    "A private video library with browser encryption, authenticated access, and keys that stay with you.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body>
        <LibraryProvider>{children}</LibraryProvider>
      </body>
    </html>
  );
}
