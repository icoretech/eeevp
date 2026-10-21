// Formatting boundaries keep zero-byte upload progress truthful and catalog dates independent of the browser timezone.
import { describe, expect, it } from "vitest";
import { formatVideoDate, formatVideoSize } from "@/lib/video/format";

describe("video size formatting", () => {
  it.each([
    [0, "0 B"],
    [1, "1 KB"],
    [1024, "1 KB"],
    [1536, "2 KB"],
    [1_048_575, "1024 KB"],
    [1_048_576, "1.0 MB"],
    [1_572_864, "1.5 MB"],
    [1_073_741_824, "1.00 GB"],
    [1_342_177_280, "1.25 GB"],
  ])("formats %s bytes as %s", (bytes, expected) => {
    expect(formatVideoSize(bytes)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid byte counts: %s",
    (bytes) => {
      expect(() => formatVideoSize(bytes)).toThrow(RangeError);
    },
  );
});

describe("video catalog date formatting", () => {
  it.each([
    ["2026-01-01T00:00:00.000Z", "Jan 1, 2026"],
    ["2026-01-01T00:15:00+02:00", "Dec 31, 2025"],
    ["2026-01-01T23:59:59-05:00", "Jan 2, 2026"],
  ])("renders %s in en-US and UTC", (value, expected) => {
    expect(formatVideoDate(value)).toBe(expected);
  });

  it("rejects an invalid date instead of displaying fallback content", () => {
    expect(() => formatVideoDate("invalid-date")).toThrow(RangeError);
  });
});
