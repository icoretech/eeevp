// Byte-range contracts cover browser seek patterns and hostile or unsatisfiable requests.
import { describe, expect, it } from "vitest";
import { resolveRange } from "@/lib/video/range";

describe("video byte ranges", () => {
  it.each([
    { header: null, size: 100, start: 0, end: 99, status: 200 },
    { header: "bytes=0-0", size: 100, start: 0, end: 0, status: 206 },
    { header: "bytes=10-19", size: 100, start: 10, end: 19, status: 206 },
    { header: "bytes=90-", size: 100, start: 90, end: 99, status: 206 },
    { header: "bytes=-10", size: 100, start: 90, end: 99, status: 206 },
    { header: "bytes=-1000", size: 100, start: 0, end: 99, status: 206 },
    {
      header: "bytes=0-9999999999999999999999999999999",
      size: 100,
      start: 0,
      end: 99,
      status: 206,
    },
    {
      header: `bytes=-${"9".repeat(400)}`,
      size: 100,
      start: 0,
      end: 99,
      status: 206,
    },
    { header: " bytes=0009-0010 ", size: 100, start: 9, end: 10, status: 206 },
    { header: "BYTES=0-", size: 1, start: 0, end: 0, status: 206 },
  ])(
    "resolves $header for a $size-byte video",
    ({ header, size, start, end, status }) => {
      expect(resolveRange(header, size)).toEqual({ start, end, status });
    },
  );

  it.each([
    "",
    "bytes=",
    "bytes=-",
    "bytes=-0",
    "bytes=100-",
    "bytes=100-101",
    "bytes=50-49",
    "bytes=0-1,2-3",
    "bytes=0-1,",
    "items=0-1",
    "bytes=1.5-2",
    "bytes=+1-2",
    "bytes=1- 2",
    "bytes= 1-2",
    "bytes=1e1-20",
    "bytes=Infinity-",
    "bytes=NaN-",
    "bytes=0--1",
    `bytes=${"9".repeat(400)}-`,
    "bytes=0-1\nbytes=2-3",
  ])("rejects malformed or unsatisfiable range %s", (header) => {
    expect(resolveRange(header, 100)).toBeNull();
  });

  it.each([
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid representation size %s", (size) => {
    expect(resolveRange(null, size)).toBeNull();
  });
});
