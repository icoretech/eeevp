// Runtime-only configuration keeps deployment secrets out of browser bundles and build steps.
import "server-only";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { credentialsSchema } from "@/lib/video/schema";

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

const common = {
  APP_ORIGIN: httpUrl.refine((value) => new URL(value).origin === value),
  SESSION_SECRET: z.string().min(32).max(4096),
};

const prefix = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);
const storageSchema = z.discriminatedUnion("STORAGE_DRIVER", [
  z.object({
    ...common,
    STORAGE_DRIVER: z.literal("filesystem"),
    STORAGE_PATH: z.string().min(1).refine(isAbsolute),
  }),
  z.object({
    ...common,
    STORAGE_DRIVER: z.literal("s3"),
    S3_ENDPOINT: httpUrl,
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1).max(255),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    S3_PREFIX: prefix,
  }),
]);

const demoSchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null) return value;
    const mode = "DEMO_MODE" in value ? value.DEMO_MODE : undefined;
    return {
      ...value,
      DEMO_MODE: mode === "true" ? true : mode === "false" ? false : mode,
    };
  },
  z.discriminatedUnion("DEMO_MODE", [
    z.object({ DEMO_MODE: z.literal(false) }),
    z.object({
      DEMO_MODE: z.literal(true),
      DEMO_PUBLIC_KEY: credentialsSchema.shape.key,
    }),
  ]),
);

const environmentSchema = z.intersection(storageSchema, demoSchema);

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
