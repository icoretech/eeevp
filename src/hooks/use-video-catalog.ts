"use client";

// Canonical catalog synchronization owns request state and retains rows while refreshes fail or are superseded.
import {
  addTransitionType,
  startTransition,
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { useLibrary } from "@/components/library-provider";
import {
  type CatalogVideo,
  fetchLibraryCatalog,
  LibrarySessionExpired,
} from "@/lib/video/catalog";

type CatalogState = {
  videos: CatalogVideo[];
  phase: "loading" | "ready";
  error: string | null;
};
type CatalogAction =
  | { type: "refresh" }
  | { type: "received"; videos: CatalogVideo[] }
  | { type: "failed"; message: string }
  | { type: "settled" }
  | { type: "removed"; id: string };
const initialCatalog: CatalogState = {
  videos: [],
  phase: "loading",
  error: null,
};

function catalogReducer(
  state: CatalogState,
  action: CatalogAction,
): CatalogState {
  switch (action.type) {
    case "refresh":
      return { ...state, phase: "loading", error: null };
    case "received":
      return { ...state, videos: action.videos, phase: "ready" };
    case "failed":
      return { ...state, error: action.message };
    case "settled":
      return { ...state, phase: "ready" };
    case "removed":
      return {
        ...state,
        videos: state.videos.filter(
          (entry) => entry.video.manifest.id !== action.id,
        ),
      };
  }
}

export function useVideoCatalog() {
  const { library, libraryKey, expire, registerCleanup } = useLibrary();
  const [catalog, dispatch] = useReducer(catalogReducer, initialCatalog);
  const request = useRef<AbortController | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!libraryKey) return;
    request.current?.abort();
    const requestId = ++requestGeneration.current;
    const controller = new AbortController();
    request.current = controller;
    dispatch({ type: "refresh" });
    let received = false;
    try {
      const videos = await fetchLibraryCatalog(
        libraryKey,
        library?.id ?? null,
        controller.signal,
      );
      if (
        !controller.signal.aborted &&
        requestGeneration.current === requestId
      ) {
        startTransition(() => {
          if (
            controller.signal.aborted ||
            requestGeneration.current !== requestId
          )
            return;
          received = true;
          addTransitionType("catalog-reveal");
          dispatch({ type: "received", videos });
        });
      }
    } catch (failure) {
      if (controller.signal.aborted || requestGeneration.current !== requestId)
        return;
      if (failure instanceof LibrarySessionExpired) {
        expire();
        return;
      }
      dispatch({
        type: "failed",
        message:
          failure instanceof Error
            ? failure.message
            : "Your video library could not be loaded.",
      });
    } finally {
      if (requestGeneration.current === requestId && !received)
        dispatch({ type: "settled" });
    }
  }, [library, libraryKey, expire]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
      request.current?.abort();
    };
  }, [refresh]);
  useEffect(
    () =>
      registerCleanup(() => {
        requestGeneration.current += 1;
        request.current?.abort();
      }),
    [registerCleanup],
  );

  function remove(id: string) {
    dispatch({ type: "removed", id });
  }
  return {
    videos: catalog.videos,
    loading: catalog.phase === "loading",
    error: catalog.error,
    refresh,
    remove,
  };
}
