// Activity metrics are bounded, deduplicated, and independent of native media play time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecryptionActivity } from "@/lib/video/decryption-activity";

afterEach(() => vi.useRealTimers());

describe("decryption activity", () => {
  it("counts each verified chunk once and exposes at most 32 visual buckets", () => {
    const source = createDecryptionActivity(33 * 10, 33);
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 32,
      plaintextBytes: 10,
      phase: "verified",
    });

    expect(source.getSnapshot()).toMatchObject({
      totalBytes: 330,
      totalChunks: 33,
      verifiedBytes: 20,
      verifiedChunks: 2,
    });
    expect(source.getSnapshot().buckets.length).toBeLessThanOrEqual(32);
    expect(
      source
        .getSnapshot()
        .buckets.filter((bucket) => bucket.status === "verified"),
    ).toHaveLength(1);
    const coverage = source
      .getSnapshot()
      .buckets.flatMap((bucket) =>
        Array.from(
          { length: bucket.endChunk - bucket.startChunk + 1 },
          (_, offset) => bucket.startChunk + offset,
        ),
      );
    expect(coverage).toEqual(Array.from({ length: 33 }, (_, index) => index));
  });

  it("coalesces listeners to bounded notifications while keeping the final snapshot", () => {
    vi.useFakeTimers();
    const source = createDecryptionActivity(20, 2);
    const listener = vi.fn();
    source.subscribe(listener);
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot().verifiedBytes).toBe(10);
  });

  it("ignores out-of-bounds activity and clears metrics on reset or close", () => {
    const source = createDecryptionActivity(20, 2);
    source.record({
      sessionId: "session",
      index: -1,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 0.5,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: Number.NaN,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 2,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: -1,
      phase: "verified",
    });
    expect(source.getSnapshot().verifiedChunks).toBe(0);
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.reset();
    expect(source.getSnapshot().verifiedBytes).toBe(0);
    source.record({
      sessionId: "session",
      index: 1,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.close();
    expect(source.getSnapshot().verifiedChunks).toBe(0);
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    expect(source.getSnapshot().verifiedChunks).toBe(0);
  });

  it("cancels pending notifications and ignores events after close", () => {
    vi.useFakeTimers();
    const source = createDecryptionActivity(20, 2);
    const listener = vi.fn();
    source.subscribe(listener);
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.close();
    listener.mockClear();
    source.record({
      sessionId: "session",
      index: 1,
      plaintextBytes: 10,
      phase: "verified",
    });
    vi.advanceTimersByTime(1_000);
    expect(listener).not.toHaveBeenCalled();
    expect(source.getSnapshot().verifiedBytes).toBe(0);
    expect(source.getSnapshot().lastVerifiedChunk).toBeNull();
  });

  it("records repeated decryptions without inflating unique verified coverage", () => {
    const source = createDecryptionActivity(20, 2);
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    expect(source.getSnapshot().verifiedChunks).toBe(1);
    expect(source.getSnapshot().verifiedBytes).toBe(10);
    expect(source.getSnapshot().verificationRevision).toBe(3);
    source.record({
      sessionId: "session",
      index: 0,
      plaintextBytes: 10,
      phase: "verified",
    });
    expect(source.getSnapshot().verificationRevision).toBe(4);
    expect(source.getSnapshot().verifiedBytes).toBe(10);
  });
});
