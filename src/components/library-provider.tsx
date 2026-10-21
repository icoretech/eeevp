"use client";

// The workspace accepts a browser-held key without checking it; encrypted records are opened locally when used.
import {
  addTransitionType,
  createContext,
  type ReactNode,
  startTransition,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { normalizeLibraryKeyInput } from "@/lib/crypto/key-input";
import { createLibraryDescriptor } from "@/lib/crypto/library-crypto";
import {
  type LibraryDescriptor,
  libraryDescriptorSchema,
} from "@/lib/video/schema";

type LibraryState = {
  status: "signed-out" | "locked" | "open";
  library: LibraryDescriptor | null;
  libraryKey: string | null;
  error: string | null;
};

type DemoConfiguration =
  | { demoMode: false; demoPublicKey: null }
  | { demoMode: true; demoPublicKey: string };

type LibraryContextValue = LibraryState &
  DemoConfiguration & {
    enter: (input: string) => Promise<void>;
    retryLibrary: () => Promise<void>;
    lock: () => Promise<void>;
    expire: () => void;
    registerCleanup: (cleanup: () => void) => () => void;
  };

const sessionSchema = z.strictObject({ authenticated: z.boolean() });
const sessionErrorSchema = z.strictObject({
  error: z.string().min(1).max(512),
});
const libraryResponseSchema = z.strictObject({
  library: libraryDescriptorSchema.nullable(),
});
const initialState: LibraryState = {
  status: "signed-out",
  library: null,
  libraryKey: null,
  error: null,
};
const LibraryContext = createContext<LibraryContextValue | null>(null);

class DemoLibraryUnavailable extends Error {
  constructor() {
    super("The demo library has not been initialized. Please try again later.");
    this.name = "DemoLibraryUnavailable";
  }
}

function browserRequest(path: string, init: RequestInit = {}) {
  return fetch(path, {
    ...init,
    mode: "same-origin",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
  });
}

async function readLibrary(signal: AbortSignal) {
  const response = await browserRequest("/api/library", { signal });
  if (!response.ok) throw new Error("Library is unavailable");
  return libraryResponseSchema.parse(await response.json()).library;
}

// Entry and explicit recovery share descriptor loading without comparing the entered key.
async function loadLibrary(
  key: string,
  signal: AbortSignal,
  demoMode: boolean,
) {
  const library = await readLibrary(signal);
  signal.throwIfAborted();
  if (library) return library;
  if (demoMode) throw new DemoLibraryUnavailable();
  let proposed: LibraryDescriptor;
  try {
    proposed = await createLibraryDescriptor(key);
  } catch {
    signal.throwIfAborted();
    // Inputs unsuitable for AES can still open an empty workspace without creating a descriptor.
    return null;
  }
  signal.throwIfAborted();
  const response = await browserRequest("/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proposed),
    signal,
  });
  signal.throwIfAborted();
  if (response.status === 409) return readLibrary(signal);
  if (response.status !== 201) throw new Error("Creation failed");
  const created = libraryResponseSchema.parse(await response.json()).library;
  if (
    !created ||
    created.id !== proposed.id ||
    created.encryptedVerifier !== proposed.encryptedVerifier
  ) {
    throw new Error("Unexpected library descriptor");
  }
  return created;
}

async function clearSession(signal: AbortSignal) {
  const response = await browserRequest("/api/session", {
    method: "DELETE",
    signal,
  });
  if (!response.ok) throw new Error("Sign out failed");
  if (sessionSchema.parse(await response.json()).authenticated)
    throw new Error("Sign out failed");
}

export function LibraryProvider({
  children,
  demo,
}: {
  children: ReactNode;
  demo: DemoConfiguration;
}) {
  const [state, setState] = useState<LibraryState>(initialState);
  const currentState = useRef(state);
  const revision = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const cleanups = useRef(new Set<() => void>());

  const commit = useCallback((next: LibraryState) => {
    currentState.current = next;
    setState(next);
  }, []);

  const beginOperation = useCallback(() => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    revision.current += 1;
    return { revision: revision.current, controller };
  }, []);

  const isCurrent = useCallback(
    (operation: ReturnType<typeof beginOperation>) =>
      operation.revision === revision.current &&
      !operation.controller.signal.aborted,
    [],
  );

  const stopResources = useCallback(() => {
    let closed = true;
    for (const cleanup of cleanups.current) {
      try {
        cleanup();
      } catch {
        closed = false;
      }
    }
    cleanups.current.clear();
    return closed;
  }, []);

  const registerCleanup = useCallback((cleanup: () => void) => {
    cleanups.current.add(cleanup);
    return () => {
      cleanups.current.delete(cleanup);
    };
  }, []);

  const expire = useCallback(() => {
    beginOperation();
    commit({
      ...initialState,
      error:
        "Your browser session expired. Enter your encryption key to continue.",
    });
    stopResources();
  }, [beginOperation, commit, stopResources]);

  const enter = useCallback(
    async (input: string) => {
      const operation = beginOperation();
      commit(initialState);
      stopResources();
      let key: string;
      try {
        key = normalizeLibraryKeyInput(input);
        if (!key) throw new Error("Empty encryption key");
      } catch {
        const message = "Enter an encryption key or a valid recovery file.";
        commit({ ...initialState, error: message });
        throw new Error(message);
      }
      let library: LibraryDescriptor | null = null;
      let sessionOpened = false;
      try {
        const response = await browserRequest("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: operation.controller.signal,
        });
        if (!isCurrent(operation)) return;
        if (!response.ok) {
          const result = sessionErrorSchema.safeParse(
            await response.json().catch(() => null),
          );
          throw new Error(
            result.success
              ? `${result.data.error} (HTTP ${response.status})`
              : `Browser session could not be opened (HTTP ${response.status}).`,
          );
        }
        const session = sessionSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (!session.success)
          throw new Error("The browser session response was invalid.");
        if (!session.data.authenticated)
          throw new Error("The browser session was not opened.");
        sessionOpened = true;
        library = await loadLibrary(
          key,
          operation.controller.signal,
          demo.demoMode,
        );
        if (!isCurrent(operation)) return;
        // Async action continuations need an explicit transition for workspace entry.
        startTransition(() => {
          if (!isCurrent(operation)) return;
          addTransitionType("library-open");
          commit({ status: "open", library, libraryKey: key, error: null });
        });
      } catch (failure) {
        if (!isCurrent(operation)) return;
        if (!sessionOpened) {
          const message =
            failure instanceof Error
              ? failure.message
              : "The browser session could not be opened. Please try again.";
          commit({ ...initialState, error: message });
          throw new Error(message);
        }
        startTransition(() => {
          if (!isCurrent(operation)) return;
          addTransitionType("library-open");
          commit({
            status: "open",
            library,
            libraryKey: key,
            error:
              failure instanceof DemoLibraryUnavailable
                ? failure.message
                : "The video library could not be loaded. Please try again.",
          });
        });
      }
    },
    [beginOperation, commit, demo.demoMode, isCurrent, stopResources],
  );

  const retryLibrary = useCallback(async () => {
    const snapshot = currentState.current;
    if (snapshot.status !== "open" || !snapshot.libraryKey) return;
    const operation = beginOperation();
    try {
      const library = await loadLibrary(
        snapshot.libraryKey,
        operation.controller.signal,
        demo.demoMode,
      );
      if (!isCurrent(operation)) return;
      commit({ ...snapshot, library, error: null });
    } catch (failure) {
      if (!isCurrent(operation)) return;
      commit({
        ...snapshot,
        error:
          failure instanceof DemoLibraryUnavailable
            ? failure.message
            : "The video library could not be loaded. Please try again.",
      });
    }
  }, [beginOperation, commit, demo.demoMode, isCurrent]);

  const lock = useCallback(async () => {
    const operation = beginOperation();
    commit({
      status: "locked",
      library: currentState.current.library,
      libraryKey: null,
      error: null,
    });
    const closed = stopResources();
    try {
      await clearSession(operation.controller.signal);
      if (!isCurrent(operation)) return;
      commit({
        ...initialState,
        error: closed
          ? null
          : "Close this tab to finish clearing browser playback resources.",
      });
    } catch {
      if (!isCurrent(operation)) return;
      commit({
        ...initialState,
        status: "locked",
        error:
          "Your key was cleared, but the browser session could not be closed. Retry locking.",
      });
    }
  }, [beginOperation, commit, isCurrent, stopResources]);

  useEffect(
    () => () => {
      revision.current += 1;
      activeRequest.current?.abort();
      currentState.current = initialState;
      stopResources();
    },
    [stopResources],
  );

  const context = useMemo(
    () => ({
      ...state,
      ...demo,
      enter,
      retryLibrary,
      lock,
      expire,
      registerCleanup,
    }),
    [state, demo, enter, retryLibrary, lock, expire, registerCleanup],
  );

  return <LibraryContext value={context}>{children}</LibraryContext>;
}

export function useLibrary() {
  const context = use(LibraryContext);
  if (!context)
    throw new Error("Library components require a LibraryProvider.");
  return context;
}
