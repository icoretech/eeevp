// Runtime-only configuration keeps deployment secrets out of browser bundles and build steps.
import "server-only";
import { isAbsolute } from "node:path";
import { z } from "zod";

const httpUrl = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    context.addIssue({ code: "custom", message: "Invalid HTTP endpoint" });
  }
});

const environmentSchema = z.object({
  APP_ORIGIN: httpUrl.refine((value) => new URL(value).origin === value),
  LIBRARY_PASSWORD: z.string().min(16).max(1024),
  SESSION_SECRET: z.string().min(32).max(4096),
  STORAGE_PATH: z.string().min(1).refine(isAbsolute),
});

export class ConfigurationError extends Error {
  constructor() {
    super("Server configuration is unavailable");
    this.name = "ConfigurationError";
  }
}

export function getConfig() {
  const result = environmentSchema.safeParse(process.env);
  if (!result.success) throw new ConfigurationError();
  return result.data;
}

export type ServerConfig = ReturnType<typeof getConfig>;
