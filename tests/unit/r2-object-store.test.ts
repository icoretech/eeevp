// SDK response contracts cover bounded streams and conditional-write ambiguity.
import { Readable } from "node:stream";
import { S3ServiceException } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { S3ObjectStore } from "../../src/lib/server/r2-object-store";

const sendMock = vi.hoisted(() =>
  vi.fn<
    (
      command: { input: object },
      options?: { abortSignal?: AbortSignal },
    ) => Promise<unknown>
  >(),
);
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...original,
    S3Client: class {
      send = sendMock;
    },
  };
});

const config = {
  endpoint: "http://localhost:9000",
  region: "auto",
  bucket: "sample",
  accessKeyId: "sample",
  secretAccessKey: "sample",
  forcePathStyle: true,
  prefix: "tests",
};
function failure(name: string, code: number) {
  return new S3ServiceException({
    name,
    message: name,
    $fault: "client",
    $metadata: { httpStatusCode: code },
  });
}
function body(parts: Uint8Array[]) {
  const stream = Readable.toWeb(Readable.from(parts));
  return { transformToWebStream: () => stream };
}
beforeEach(() => sendMock.mockReset());
describe("single bucket object IO", () => {
  it("publishes atomically into the fixed namespace and treats only 412 as existing", async () => {
    const send = sendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(failure("PreconditionFailed", 412))
      .mockRejectedValueOnce(failure("ConditionalRequestConflict", 409))
      .mockRejectedValueOnce(new Error("timeout"));
    const store = new S3ObjectStore(config);
    expect(await store.publish("video/chunk", "first")).toBe(true);
    expect(await store.publish("video/chunk", "second")).toBe(false);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "sample",
      Key: "tests/video/chunk",
      IfNoneMatch: "*",
    });
    await expect(store.publish("video/chunk", "third")).rejects.toThrow(
      "ConditionalRequestConflict",
    );
    await expect(store.publish("video/chunk", "fourth")).rejects.toThrow(
      "timeout",
    );
    expect(send).toHaveBeenCalledTimes(4);
  });
  it("bounds actual bytes without trusting length and aborts on overflow", async () => {
    const send = sendMock.mockResolvedValue({
      Body: body([Buffer.from("abc"), Buffer.from("def")]),
    });
    await expect(
      new S3ObjectStore(config).read("video/chunk", 5),
    ).rejects.toThrow("read limit");
    const options = send.mock.calls[0]?.[1];
    expect(options).toHaveProperty("abortSignal.aborted", true);
  });
  it("rejects oversized declared length before consuming the stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    sendMock.mockResolvedValue({
      ContentLength: 100,
      Body: { transformToWebStream: () => stream },
    });
    await expect(
      new S3ObjectStore(config).read("video/chunk", 5),
    ).rejects.toThrow("read limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("reads exact bytes and rejects truncated data and stream failures", async () => {
    sendMock
      .mockResolvedValueOnce({
        ContentLength: 3,
        Body: body([Buffer.from("abc")]),
      })
      .mockResolvedValueOnce({
        ContentLength: 4,
        Body: body([Buffer.from("abc")]),
      })
      .mockResolvedValueOnce({
        Body: {
          transformToWebStream: () =>
            new ReadableStream({
              start(controller) {
                controller.error(new Error("broken stream"));
              },
            }),
        },
      });
    const store = new S3ObjectStore(config);
    expect(await store.read("video/chunk", 3)).toEqual(Buffer.from("abc"));
    await expect(store.read("video/chunk", 4)).rejects.toThrow(
      "length mismatch",
    );
    await expect(store.read("video/chunk", 4)).rejects.toThrow("broken stream");
  });
  it("distinguishes missing objects from bucket and authorization errors", async () => {
    sendMock
      .mockRejectedValueOnce(failure("NoSuchKey", 404))
      .mockRejectedValueOnce(failure("NoSuchBucket", 404))
      .mockRejectedValueOnce(failure("AccessDenied", 403));
    const store = new S3ObjectStore(config);
    expect(await store.read("absent", 5)).toBeNull();
    await expect(store.read("absent", 5)).rejects.toThrow("NoSuchBucket");
    await expect(store.head("absent")).rejects.toThrow("AccessDenied");
  });
  it("validates head sizes", async () => {
    sendMock
      .mockResolvedValueOnce({ ContentLength: 0 })
      .mockResolvedValueOnce({ ContentLength: -1 });
    const store = new S3ObjectStore(config);
    expect(await store.head("zero")).toEqual({ size: 0 });
    await expect(store.head("bad")).rejects.toThrow("Invalid object size");
  });
  it("reads every listing page and refuses token loops", async () => {
    const send = sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: "tests/video/a" }],
        IsTruncated: true,
        NextContinuationToken: "next",
      })
      .mockResolvedValueOnce({ Contents: [{ Key: "tests/video/b" }] })
      .mockResolvedValue({ IsTruncated: true, NextContinuationToken: "loop" });
    const store = new S3ObjectStore(config);
    expect(await store.list("video/")).toEqual(["video/a", "video/b"]);
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      ContinuationToken: "next",
    });
    await expect(store.list("")).rejects.toThrow("continuation");
  });
  it("refuses missing continuation tokens and foreign namespace keys", async () => {
    sendMock
      .mockResolvedValueOnce({ IsTruncated: true })
      .mockResolvedValueOnce({ Contents: [{ Key: "elsewhere/video" }] });
    const store = new S3ObjectStore(config);
    await expect(store.list("")).rejects.toThrow("continuation");
    await expect(store.list("")).rejects.toThrow("listed object key");
  });
  it("does not delete a probe whose conditional write outcome is unknown", async () => {
    sendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("write timed out"));
    await expect(new S3ObjectStore(config).ready()).rejects.toThrow(
      "write timed out",
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
  it("deletes a confirmed probe after a failed read", async () => {
    sendMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce({});
    await expect(new S3ObjectStore(config).ready()).rejects.toThrow(
      "read failed",
    );
    expect(sendMock).toHaveBeenCalledTimes(4);
    expect(sendMock.mock.calls[3]?.[0].constructor.name).toBe(
      "DeleteObjectCommand",
    );
    expect(sendMock.mock.calls[3]?.[0].input).toEqual(
      sendMock.mock.calls[2]?.[0].input,
    );
  });
  it.each(["", "/root", "../escape", "a/../b", "a\\b", "a\0b", "a//b"])(
    "rejects unsafe key %j without SDK calls",
    async (key) => {
      const send = sendMock;
      await expect(
        new S3ObjectStore(config).publish(key, "data"),
      ).rejects.toThrow("Invalid object key");
      expect(send).not.toHaveBeenCalled();
    },
  );
});
