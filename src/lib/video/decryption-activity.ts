// Browser-memory-only telemetry records authenticated chunk decryptions without exposing video secrets.
export type DecryptionActivityEvent = {
  sessionId: string;
  index: number;
  plaintextBytes: number;
  phase: "verified";
};

export type DecryptionActivityBucket = {
  index: number;
  startChunk: number;
  endChunk: number;
  status: "pending" | "verified";
};

export type DecryptionActivitySnapshot = {
  totalBytes: number;
  totalChunks: number;
  verifiedBytes: number;
  verifiedChunks: number;
  lastVerifiedChunk: number | null;
  verificationRevision: number;
  buckets: readonly DecryptionActivityBucket[];
};

export type DecryptionActivitySource = {
  getSnapshot: () => DecryptionActivitySnapshot;
  subscribe: (listener: () => void) => () => void;
  record: (event: DecryptionActivityEvent) => void;
  reset: () => void;
  close: () => void;
};

const MAX_BUCKETS = 32;
const NOTIFY_INTERVAL = 200;

function createBuckets(
  totalChunks: number,
  verified: ReadonlySet<number>,
): readonly DecryptionActivityBucket[] {
  const count = Math.min(MAX_BUCKETS, totalChunks);
  return Array.from({ length: count }, (_, index) => {
    const startChunk = Math.floor((index * totalChunks) / count);
    const endChunk = Math.floor(((index + 1) * totalChunks) / count) - 1;
    let verifiedCount = 0;
    for (let chunk = startChunk; chunk <= endChunk; chunk += 1) {
      if (verified.has(chunk)) verifiedCount += 1;
    }
    return {
      index,
      startChunk,
      endChunk,
      status:
        verifiedCount === endChunk - startChunk + 1 ? "verified" : "pending",
    };
  });
}

export function createDecryptionActivity(
  totalBytes: number,
  totalChunks: number,
): DecryptionActivitySource {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1)
    throw new Error("Activity total bytes must be positive.");
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1)
    throw new Error("Activity total chunks must be positive.");
  const verified = new Set<number>();
  const listeners = new Set<() => void>();
  let closed = false;
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: DecryptionActivitySnapshot = {
    totalBytes,
    totalChunks,
    verifiedBytes: 0,
    verifiedChunks: 0,
    lastVerifiedChunk: null,
    verificationRevision: 0,
    buckets: createBuckets(totalChunks, verified),
  };
  const clearTimer = () => {
    if (notificationTimer !== undefined) {
      clearTimeout(notificationTimer);
      notificationTimer = undefined;
    }
  };
  const notify = () => {
    notificationTimer = undefined;
    if (!closed) for (const listener of listeners) listener();
  };
  const scheduleNotify = () => {
    if (notificationTimer === undefined && !closed)
      notificationTimer = setTimeout(notify, NOTIFY_INTERVAL);
  };
  const reset = () => {
    clearTimer();
    verified.clear();
    snapshot = {
      ...snapshot,
      verifiedBytes: 0,
      verifiedChunks: 0,
      lastVerifiedChunk: null,
      verificationRevision: 0,
      buckets: createBuckets(totalChunks, verified),
    };
    if (!closed) for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record: (event) => {
      if (
        closed ||
        event.phase !== "verified" ||
        !Number.isSafeInteger(event.index) ||
        event.index < 0 ||
        event.index >= totalChunks ||
        !Number.isSafeInteger(event.plaintextBytes) ||
        event.plaintextBytes < 1
      )
        return;
      const firstVerification = !verified.has(event.index);
      if (firstVerification) verified.add(event.index);
      snapshot = {
        ...snapshot,
        verifiedBytes: firstVerification
          ? snapshot.verifiedBytes + event.plaintextBytes
          : snapshot.verifiedBytes,
        verifiedChunks: verified.size,
        lastVerifiedChunk: event.index,
        verificationRevision: snapshot.verificationRevision + 1,
        buckets: createBuckets(totalChunks, verified),
      };
      scheduleNotify();
    },
    reset,
    close: () => {
      if (closed) return;
      reset();
      closed = true;
      listeners.clear();
    },
  };
}
