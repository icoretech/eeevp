"use client";

// Quiet, bounded playback telemetry updates only this reserved-height HUD, never the native video element.
import { startTransition, useEffect, useRef, useState } from "react";
import type { DecryptionActivitySource } from "@/lib/video/decryption-activity";

function LiveDecryptionActivity({
  activity,
}: {
  activity: DecryptionActivitySource;
}) {
  const [view, setView] = useState(() => ({
    snapshot: activity.getSnapshot(),
    pulse: 0,
  }));
  const latest = useRef(view.snapshot);
  useEffect(() => {
    let stopped = false;
    const publish = () => {
      const snapshot = activity.getSnapshot();
      if (stopped || snapshot === latest.current) return;
      const verified =
        snapshot.verificationRevision > latest.current.verificationRevision;
      latest.current = snapshot;
      // Source notifications are bounded to 5 Hz; nonurgent telemetry must not cancel navigation transitions.
      startTransition(() =>
        setView((previous) => ({
          snapshot,
          pulse: previous.pulse + (verified ? 1 : 0),
        })),
      );
    };
    const unsubscribe = activity.subscribe(publish);
    publish();
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [activity]);

  const snapshot = view.snapshot;
  const buckets = snapshot.buckets.slice(0, 32);
  const current = snapshot.lastVerifiedChunk;
  const phase =
    snapshot.verifiedChunks > 0 ? "Verified locally" : "Waiting for chunks";
  const currentLabel =
    current === null
      ? `${snapshot.verifiedChunks} / ${snapshot.totalChunks} blocks verified`
      : `Block ${current + 1} / ${snapshot.totalChunks}`;
  const verifiedMiB = (snapshot.verifiedBytes / 1_048_576).toFixed(2);

  return (
    <section
      className="decryption-activity"
      aria-label="Browser decryption activity"
      aria-live="off"
    >
      <div className="decryption-activity-heading">
        <span className="decryption-activity-label">
          Browser decryption
          <span className="decryption-activity-phase">{phase}</span>
        </span>
        <span className="decryption-activity-block">{currentLabel}</span>
      </div>
      <div className="decryption-activity-details">
        <div
          className="decryption-activity-cells"
          aria-hidden="true"
          style={{
            gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))`,
            maxWidth: buckets.length * 7 + Math.max(0, buckets.length - 1) * 3,
          }}
        >
          {buckets.map((bucket) => (
            <span
              className="decryption-activity-cell"
              data-state={bucket.status}
              key={bucket.index}
            >
              {view.pulse > 0 &&
                snapshot.lastVerifiedChunk !== null &&
                snapshot.lastVerifiedChunk >= bucket.startChunk &&
                snapshot.lastVerifiedChunk <= bucket.endChunk && (
                  <span
                    className="decryption-activity-pulse"
                    key={view.pulse}
                  />
                )}
            </span>
          ))}
        </div>
        <span className="decryption-activity-bytes">
          {verifiedMiB} MiB verified
        </span>
      </div>
      <span className="sr-only">
        {snapshot.verifiedChunks} of {snapshot.totalChunks} unique blocks
        verified. {snapshot.verifiedBytes} of {snapshot.totalBytes} bytes
        verified.
      </span>
    </section>
  );
}

export function DecryptionActivity({
  activity,
}: {
  activity: DecryptionActivitySource | null;
}) {
  if (activity) return <LiveDecryptionActivity activity={activity} />;
  return (
    <section
      className="decryption-activity"
      aria-label="Browser decryption activity"
      aria-live="off"
    >
      <div className="decryption-activity-heading">
        <span className="decryption-activity-label">Browser decryption</span>
        <span className="decryption-activity-phase">No active decryption</span>
      </div>
      <div className="decryption-activity-details">
        <span className="decryption-activity-idle-track" aria-hidden="true" />
        <span className="decryption-activity-idle-label">
          Waiting for encrypted chunks
        </span>
      </div>
    </section>
  );
}
