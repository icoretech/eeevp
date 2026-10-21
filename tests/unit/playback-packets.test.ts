// Deterministic network gates verify ciphertext-only budgets, leases and bounded parallelism.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CiphertextCache, PlaybackPackets } from "@/workers/playback-packets";

afterEach(() => vi.useRealTimers());
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ciphertext packet scheduler", () => {
  it("caps concurrent downloads at three, deduplicates readers and aborts only orphaned work", async () => {
    const gates = new Map<
      number,
      ReturnType<typeof Promise.withResolvers<ArrayBuffer>>
    >();
    const signals = new Map<number, AbortSignal>();
    const load = vi.fn((index: number, signal: AbortSignal) => {
      const gate = Promise.withResolvers<ArrayBuffer>();
      gates.set(index, gate);
      signals.set(index, signal);
      signal.addEventListener("abort", () => gate.reject(signal.reason));
      return gate.promise;
    });
    const packets = new PlaybackPackets("owner-a", new CiphertextCache(), load);
    const first = packets.acquire(0);
    const duplicate = packets.acquire(0);
    const second = packets.acquire(1);
    const third = packets.acquire(2);
    const queued = packets.acquire(3);
    expect(load.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
    first.release();
    expect(signals.get(0)?.aborted).toBe(false);
    duplicate.release();
    expect(signals.get(0)?.aborted).toBe(true);
    await tick();
    expect(load.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3]);
    gates.get(3)?.resolve(new ArrayBuffer(11));
    expect((await queued.promise).byteLength).toBe(11);
    second.release();
    third.release();
    queued.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(signals.get(1)?.aborted).toBe(true);
    expect(signals.get(2)?.aborted).toBe(true);
    await tick();
  });

  it("reuses in-flight packets across native range handoff and expires orphan grace exactly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signal = new AbortController();
    const gate = Promise.withResolvers<ArrayBuffer>();
    let transportSignal = signal.signal;
    const load = vi.fn((_index: number, current: AbortSignal) => {
      transportSignal = current;
      current.addEventListener("abort", () => gate.reject(current.reason));
      return gate.promise;
    });
    const packets = new PlaybackPackets("a", new CiphertextCache(), load);
    const first = packets.acquire(7);
    first.release();
    await vi.advanceTimersByTimeAsync(49);
    expect(transportSignal.aborted).toBe(false);
    const handoff = packets.acquire(7);
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(1);
    expect(transportSignal.aborted).toBe(false);
    handoff.release();
    await vi.advanceTimersByTimeAsync(49);
    expect(transportSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(transportSignal.aborted).toBe(true);
    await expect(handoff.promise).rejects.toThrow("no longer needed");
  });

  it("bypasses grace immediately for lock and for a new seek requiring occupied slots", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signals = new Map<number, AbortSignal>();
    const load = vi.fn((index: number, signal: AbortSignal) => {
      signals.set(index, signal);
      return new Promise<ArrayBuffer>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    });
    const packets = new PlaybackPackets("a", new CiphertextCache(), load);
    const old = [0, 1, 2].map((index) => packets.acquire(index));
    for (const item of old) item.release();
    expect([...signals.values()].every((signal) => !signal.aborted)).toBe(true);
    const fresh = packets.acquire(19);
    expect([0, 1, 2].every((index) => signals.get(index)?.aborted)).toBe(true);
    await tick();
    expect(load.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 19]);
    expect(signals.get(19)?.aborted).toBe(false);
    fresh.release();
    expect(vi.getTimerCount()).toBe(1);
    packets.close();
    expect(signals.get(19)?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await tick();
  });

  it("drops queued lookahead before it can consume a network slot", async () => {
    const gates = new Map<
      number,
      ReturnType<typeof Promise.withResolvers<ArrayBuffer>>
    >();
    const load = vi.fn((index: number) => {
      const gate = Promise.withResolvers<ArrayBuffer>();
      gates.set(index, gate);
      return gate.promise;
    });
    const packets = new PlaybackPackets("a", new CiphertextCache(), load);
    for (let index = 0; index < 3; index += 1) packets.acquire(index);
    const obsolete = packets.acquire(3);
    obsolete.release();
    const fresh = packets.acquire(4);
    gates.get(0)?.resolve(new ArrayBuffer(19));
    await tick();
    expect(load.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 4]);
    gates.get(4)?.resolve(new ArrayBuffer(11));
    expect((await fresh.promise).byteLength).toBe(11);
    gates.get(1)?.resolve(new ArrayBuffer(19));
    gates.get(2)?.resolve(new ArrayBuffer(19));
    await tick();
    packets.close();
  });

  it("reuses packets only inside the originating session until TTL and clears on lock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cache = new CiphertextCache();
    const load = vi.fn(async () => new ArrayBuffer(19));
    const a = new PlaybackPackets("a", cache, load);
    const b = new PlaybackPackets("b", cache, load);
    await a.acquire(0).promise;
    await tick();
    await a.acquire(0).promise;
    expect(load).toHaveBeenCalledTimes(1);
    await b.acquire(0).promise;
    expect(load).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 30_001);
    await a.acquire(0).promise;
    expect(load).toHaveBeenCalledTimes(3);
    a.close();
    expect(cache.get("a", 0)).toBeUndefined();
  });

  it("enforces eight MiB per session and thirty-two MiB globally with LRU eviction", () => {
    const cache = new CiphertextCache();
    const packet = new ArrayBuffer(1024 * 1024);
    for (let index = 0; index < 8; index += 1) cache.put("a", index, packet);
    expect(cache.get("a", 0)).toBe(packet);
    cache.put("a", 8, packet);
    expect(cache.get("a", 1)).toBeUndefined();
    expect(cache.get("a", 0)).toBe(packet);
    for (const session of ["b", "c", "d", "e"]) {
      for (let index = 0; index < 8; index += 1)
        cache.put(session, index, packet);
    }
    for (let index = 0; index < 9; index += 1)
      expect(cache.get("a", index)).toBeUndefined();
    expect(cache.get("b", 0)).toBe(packet);
    cache.clear("b");
    expect(cache.get("b", 0)).toBeUndefined();
    expect(cache.get("c", 0)).toBe(packet);
  });
});
