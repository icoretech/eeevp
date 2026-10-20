// Resolve one HTTP byte range so encrypted videos can seek without downloading unrelated chunks.
export function resolveRange(header: string | null, size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (header === null) return { start: 0, end: size - 1, status: 200 as const };

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    return {
      start: suffix >= size ? 0 : size - suffix,
      end: size - 1,
      status: 206 as const,
    };
  }

  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) return null;
  return { start, end, status: 206 as const };
}
