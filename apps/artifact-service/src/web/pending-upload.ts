const DATABASE_NAME = "artifactpass-pending-upload";
const DATABASE_VERSION = 1;
const STORE_NAME = "uploads";
const RECORD_KEY = "homepage";
const INTENT_MARKER = "artifactpass-pending-upload";
const MAXIMUM_RECORD_AGE_MS = 60 * 60 * 1000;

interface PendingUploadRecord {
  readonly key: typeof RECORD_KEY;
  readonly version: 1;
  readonly name: string;
  readonly type: string;
  readonly lastModified: number;
  readonly bytes: ArrayBuffer;
  readonly expiresInSeconds: number;
  readonly createdAt: number;
}

export interface PendingUpload {
  readonly file: File;
  readonly expiresInSeconds: number;
}

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Pending upload storage is unavailable.")));
  });

const transact = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result!: T;
      request.addEventListener("success", () => {
        result = request.result;
      });
      request.addEventListener("error", () => reject(request.error ?? new Error("Pending upload storage failed.")));
      transaction.addEventListener("complete", () => resolve(result));
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Pending upload storage was interrupted.")));
    });
  } finally {
    database.close();
  }
};

const isPendingUploadRecord = (value: unknown): value is PendingUploadRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PendingUploadRecord>;
  return record.key === RECORD_KEY &&
    record.version === 1 &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    typeof record.type === "string" &&
    typeof record.lastModified === "number" && Number.isFinite(record.lastModified) &&
    record.bytes instanceof ArrayBuffer &&
    record.bytes.byteLength > 0 &&
    typeof record.expiresInSeconds === "number" && Number.isFinite(record.expiresInSeconds) &&
    record.expiresInSeconds > 0 &&
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt);
};

export const hasPendingUploadIntent = (): boolean =>
  sessionStorage.getItem(INTENT_MARKER) === "1";

export const clearPendingUpload = async (): Promise<void> => {
  sessionStorage.removeItem(INTENT_MARKER);
  await transact("readwrite", (store) => store.delete(RECORD_KEY));
};

export const readPendingUpload = async (): Promise<PendingUpload | null> => {
  const value = await transact<unknown>("readonly", (store) => store.get(RECORD_KEY));
  if (!isPendingUploadRecord(value) || Date.now() - value.createdAt > MAXIMUM_RECORD_AGE_MS) {
    await clearPendingUpload();
    return null;
  }
  return {
    file: new File([value.bytes], value.name, {
      type: value.type,
      lastModified: value.lastModified,
    }),
    expiresInSeconds: value.expiresInSeconds,
  };
};
