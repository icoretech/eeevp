// Video sizes and catalog dates use consistent labels across upload progress and server-backed library rows.
const videoDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatVideoSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0)
    throw new RangeError("Video size must be a finite, nonnegative number.");
  if (bytes === 0) return "0 B";
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function formatVideoDate(value: string) {
  return videoDateFormatter.format(new Date(value));
}
