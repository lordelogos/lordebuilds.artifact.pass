export interface StoredObject {
  readonly size: number;
  readonly body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ArtifactObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(
    key: string,
    range?: { readonly offset: number; readonly length: number },
  ): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export class R2ArtifactObjectStore implements ArtifactObjectStore {
  public constructor(private readonly bucket: R2Bucket) {}

  public async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
  }

  public async get(
    key: string,
    range?: { readonly offset: number; readonly length: number },
  ): Promise<StoredObject | null> {
    const object = await this.bucket.get(key, range === undefined ? undefined : { range });
    if (object === null) return null;
    return {
      size: object.size,
      body: object.body,
      arrayBuffer: () => object.arrayBuffer(),
    };
  }

  public async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

