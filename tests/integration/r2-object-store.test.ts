// Explicit opt-in contract against a real S3-compatible endpoint and isolated prefix.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { S3ObjectStore } from "../../src/lib/server/r2-object-store";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing integration setting: ${name}`);
  return value;
}

it.skipIf(process.env.S3_CONTRACT_TEST !== "true")(
  "real object storage preserves exclusive publish, bounded reads, full pagination and idempotent deletion",
  async () => {
    const style = required("S3_FORCE_PATH_STYLE");
    if (style !== "true" && style !== "false")
      throw new Error("Invalid S3_FORCE_PATH_STYLE");
    const store = new S3ObjectStore({
      endpoint: required("S3_ENDPOINT"),
      region: required("S3_REGION"),
      bucket: required("S3_BUCKET"),
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: style === "true",
      prefix: `${required("S3_PREFIX")}/contract-${randomUUID()}`,
    });
    try {
      await store.ready();
      const winners = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          store.publish("race", `writer-${index}`),
        ),
      );
      expect(winners.filter(Boolean)).toHaveLength(1);
      expect((await store.read("race", 32))?.toString()).toBe(
        `writer-${winners.indexOf(true)}`,
      );
      await expect(store.read("race", 1)).rejects.toThrow("read limit");
      expect(await store.head("race")).toEqual({ size: 8 });
      expect(await store.read("absent", 8)).toBeNull();
      for (let offset = 0; offset < 1001; offset += 25) {
        await Promise.all(
          Array.from({ length: Math.min(25, 1001 - offset) }, (_, index) =>
            store.publish(
              `pages/${String(offset + index).padStart(4, "0")}`,
              "x",
            ),
          ),
        );
      }
      const listed = await store.list("pages/");
      expect(listed).toHaveLength(1001);
      expect(new Set(listed).size).toBe(1001);
      await store.remove("race");
      await store.remove("race");
      expect(await store.head("race")).toBeNull();
    } finally {
      const keys = await store.list("");
      for (let offset = 0; offset < keys.length; offset += 25)
        await Promise.all(
          keys.slice(offset, offset + 25).map((key) => store.remove(key)),
        );
      expect(await store.list("")).toEqual([]);
    }
  },
  180_000,
);
