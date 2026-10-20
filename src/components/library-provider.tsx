"use client";

// The root provider keeps the library key in memory and coordinates private browser resources.
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import {
  createLibraryDescriptor,
  verifyLibraryKey,
} from "@/lib/crypto/library-crypto";
import {
  type LibraryDescriptor,
  libraryDescriptorSchema,
} from "@/lib/video/schema";

type LibraryState = {
  status: "loading" | "signed-out" | "needs-setup" | "locked" | "unlocked";
  library: LibraryDescriptor | null;
  libraryKey: string | null;
  error: string | null;
};

type LibraryContextValue = LibraryState & {
  authenticate: (password: string) => Promise<void>;
  initialize: (key: string) => Promise<void>;
  unlock: (key: string) => Promise<void>;
  lock: () => Promise<void>;
  expire: () => void;
  registerCleanup: (cleanup: () => void) => () => void;
};

const sessionSchema = z.strictObject({ authenticated: z.boolean() });
const libraryResponseSchema = z.strictObject({
  library: libraryDescriptorSchema.nullable(),
});
const initialState: LibraryState = {
  status: "loading",
  library: null,
  libraryKey: null,
  error: null,
};
const LibraryContext = createContext<LibraryContextValue | null>(null);

function browserRequest(path: string, init: RequestInit = {}) {
  return fetch(path, {
    mode: "same-origin",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    ...init,
  });
}

async function readLibrary(signal: AbortSignal) {
  const response = await browserRequest("/api/library", { signal });
  if (response.status === 401) throw new Error("Session expired");
  if (!response.ok) throw new Error("Library is unavailable");
  return libraryResponseSchema.parse(await response.json()).library;
}

export function LibraryProvider({ children }: { children: ReactNode }) {
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
      status: "signed-out",
      library: null,
      libraryKey: null,
      error: "Your session expired. Sign in again to continue.",
    });
    stopResources();
  }, [beginOperation, commit, stopResources]);

  const authenticate = useCallback(
    async (password: string) => {
      const operation = beginOperation();
      commit({ ...currentState.current, error: null });
      let signedIn = false;
      try {
        const response = await browserRequest("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
          signal: operation.controller.signal,
        });
        if (response.status === 401)
          throw new Error("Incorrect library password. Try again.");
        if (!response.ok) throw new Error("Could not sign in. Please retry.");
        if (!sessionSchema.parse(await response.json()).authenticated)
          throw new Error("Could not sign in. Please retry.");
        signedIn = true;
        const library = await readLibrary(operation.controller.signal);
        if (!isCurrent(operation)) return;
        commit({
          status: library ? "locked" : "needs-setup",
          library,
          libraryKey: null,
          error: null,
        });
      } catch (error) {
        if (!isCurrent(operation)) return;
        const message = signedIn
          ? "Signed in, but library details could not be loaded. Retry signing in."
          : error instanceof Error &&
              error.message === "Incorrect library password. Try again."
            ? error.message
            : "Could not sign in. Please retry.";
        commit({
          status: "signed-out",
          library: null,
          libraryKey: null,
          error: message,
        });
        throw new Error(message);
      }
    },
    [beginOperation, commit, isCurrent],
  );

  const initialize = useCallback(
    async (key: string) => {
      if (currentState.current.status !== "needs-setup")
        throw new Error("Sign in before initializing a library.");
      const operation = beginOperation();
      commit({ ...currentState.current, error: null });
      try {
        const library = await createLibraryDescriptor(key);
        await verifyLibraryKey(library, key);
        if (!isCurrent(operation)) return;
        const response = await browserRequest("/api/library", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(library),
          signal: operation.controller.signal,
        });
        if (response.status === 401) {
          expire();
          return;
        }
        if (response.status === 409) {
          const existing = await readLibrary(operation.controller.signal);
          if (!isCurrent(operation)) return;
          if (!existing) throw new Error("Library is unavailable");
          commit({
            status: "locked",
            library: existing,
            libraryKey: null,
            error:
              "This library was already initialized. Enter its existing library key to unlock it.",
          });
          return;
        }
        if (response.status !== 201) throw new Error("Creation failed");
        const created = libraryResponseSchema.parse(
          await response.json(),
        ).library;
        if (
          !created ||
          created.id !== library.id ||
          created.encryptedVerifier !== library.encryptedVerifier
        )
          throw new Error("Unexpected library descriptor");
        if (!isCurrent(operation)) return;
        commit({
          status: "unlocked",
          library: created,
          libraryKey: key,
          error: null,
        });
      } catch {
        if (!isCurrent(operation)) return;
        const message = "Could not initialize the library. Please retry.";
        commit({ ...currentState.current, libraryKey: null, error: message });
        throw new Error(message);
      }
    },
    [beginOperation, commit, expire, isCurrent],
  );

  const unlock = useCallback(
    async (key: string) => {
      const { library, status } = currentState.current;
      if (!library || status !== "locked")
        throw new Error("Sign in before unlocking your library.");
      const operation = beginOperation();
      commit({ ...currentState.current, error: null });
      try {
        await verifyLibraryKey(library, key);
        if (!isCurrent(operation)) return;
        commit({
          status: "unlocked",
          library,
          libraryKey: key,
          error: null,
        });
      } catch {
        if (!isCurrent(operation)) return;
        const message =
          "Incorrect library key. Use the key saved when this library was created.";
        commit({ status: "locked", library, libraryKey: null, error: message });
        throw new Error(message);
      }
    },
    [beginOperation, commit, isCurrent],
  );

  const lock = useCallback(async () => {
    const operation = beginOperation();
    const { library } = currentState.current;
    commit({
      status: library ? "locked" : "signed-out",
      library,
      libraryKey: null,
      error: null,
    });
    const closed = stopResources();
    try {
      const response = await browserRequest("/api/session", {
        method: "DELETE",
        signal: operation.controller.signal,
      });
      if (!response.ok) throw new Error("Sign out failed");
      if (!isCurrent(operation)) return;
      commit({
        status: "signed-out",
        library: null,
        libraryKey: null,
        error: closed
          ? null
          : "Close this tab to finish clearing browser playback resources.",
      });
    } catch {
      if (!isCurrent(operation)) return;
      commit({
        status: library ? "locked" : "signed-out",
        library,
        libraryKey: null,
        error:
          "Your browser key was cleared, but server access may still be authenticated. Retry signing out.",
      });
    }
  }, [beginOperation, commit, isCurrent, stopResources]);

  useEffect(() => {
    const operation = beginOperation();
    async function restoreSession() {
      try {
        const response = await browserRequest("/api/session", {
          signal: operation.controller.signal,
        });
        if (!response.ok) throw new Error("Session is unavailable");
        const session = sessionSchema.parse(await response.json());
        const library = session.authenticated
          ? await readLibrary(operation.controller.signal)
          : null;
        if (!isCurrent(operation)) return;
        commit({
          status: session.authenticated
            ? library
              ? "locked"
              : "needs-setup"
            : "signed-out",
          library,
          libraryKey: null,
          error: null,
        });
      } catch {
        if (!isCurrent(operation)) return;
        commit({
          status: "signed-out",
          library: null,
          libraryKey: null,
          error: "Could not check library access. Sign in to retry.",
        });
      }
    }
    void restoreSession();
    return () => {
      revision.current += 1;
      activeRequest.current?.abort();
      stopResources();
    };
  }, [beginOperation, commit, isCurrent, stopResources]);

  return (
    <LibraryContext
      value={{
        ...state,
        authenticate,
        initialize,
        unlock,
        lock,
        expire,
        registerCleanup,
      }}
    >
      {children}
    </LibraryContext>
  );
}

export function useLibrary() {
  const context = use(LibraryContext);
  if (!context)
    throw new Error("Library components require a LibraryProvider.");
  return context;
}
