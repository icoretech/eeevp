"use client";

import { usePathname } from "next/navigation";
// Native React view transitions keep App Router navigation and catalog changes coordinated without owning media or key lifecycles.
import { type ReactNode, ViewTransition } from "react";
import { useLibrary } from "@/components/library-provider";

export function MotionMain({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <main
      className={
        pathname.startsWith("/watch/")
          ? "main-content player-content"
          : "main-content"
      }
    >
      {children}
    </main>
  );
}

export function PageTransition({ children }: { children: ReactNode }) {
  const { status } = useLibrary();
  const open = status === "open";
  // Keep the boundary mounted so only newly opened sections enter; locked key entry is never named for a snapshot.
  return (
    <ViewTransition
      default="none"
      enter={
        open
          ? {
              "nav-forward": "page-forward",
              "nav-back": "page-back",
              default: "page-enter",
            }
          : "none"
      }
      exit={
        open
          ? {
              "nav-forward": "page-forward",
              "nav-back": "page-back",
              default: "page-exit",
            }
          : "none"
      }
      update={
        open
          ? {
              "nav-forward": "page-forward",
              "nav-back": "page-back",
              default: "none",
            }
          : "none"
      }
    >
      <div className={open ? "motion-page" : undefined}>{children}</div>
    </ViewTransition>
  );
}

export function WorkspaceSection({
  children,
  area,
}: {
  children: ReactNode;
  area: "heading" | "panels";
}) {
  return (
    <ViewTransition
      default="none"
      enter={{
        "library-open": `workspace-${area}`,
        default: "none",
      }}
    >
      {children}
    </ViewTransition>
  );
}

export function CatalogTransition({
  children,
  id,
}: {
  children: ReactNode;
  id: string;
}) {
  return (
    <ViewTransition
      name={`catalog-${id}`}
      default="none"
      enter="catalog-enter"
      exit="catalog-exit"
      update="catalog-move"
    >
      <div className="motion-catalog-item">{children}</div>
    </ViewTransition>
  );
}
