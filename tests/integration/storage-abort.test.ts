// Exercise real AWS SDK HTTP cancellation against a stalled local S3-compatible response.
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { S3ObjectStore } from "@/lib/server/r2-object-store";

it("disconnects a pending SDK object body when the incoming media request is canceled", async () => {
  const bodyStarted = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": "1048576",
    });
    response.write(Buffer.alloc(1024), () => bodyStarted.resolve());
    response.on("close", () => disconnected.resolve());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local HTTP port");
  try {
    const store = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "auto",
      bucket: "sample",
      prefix: "media",
      accessKeyId: "sample",
      secretAccessKey: "sample",
      forcePathStyle: true,
    });
    const canceled = new AbortController();
    canceled.abort(new Error("already canceled"));
    await expect(store.read("chunk", 1048576, canceled.signal)).rejects.toThrow(
      "already canceled",
    );
    await expect(store.head("chunk", canceled.signal)).rejects.toThrow(
      "already canceled",
    );
    expect(requests).toBe(0);
    const active = new AbortController();
    const reading = store.read("chunk", 1048576, active.signal);
    const rejected = expect(reading).rejects.toThrow();
    await bodyStarted.promise;
    active.abort(new Error("seek superseded"));
    await rejected;
    await disconnected.promise;
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
