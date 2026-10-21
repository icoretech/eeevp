// Durable raw object IO shared by filesystem and single-bucket storage adapters.
export interface ObjectStore {
  read(
    key: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Buffer | null>;
  publish(key: string, body: string | Uint8Array): Promise<boolean>;
  head(key: string, signal?: AbortSignal): Promise<{ size: number } | null>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  ready(): Promise<void>;
}

export interface S3StoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
}
