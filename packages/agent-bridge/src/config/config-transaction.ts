import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

const lockRetryMilliseconds = 25;
const lockTimeoutMilliseconds = 5_000;
const staleLockMilliseconds = 30_000;

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

const removeAbandonedLock = async (lockPath: string): Promise<boolean> => {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs < staleLockMilliseconds) return false;
  let owner: { readonly pid?: unknown } = {};
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8")) as { readonly pid?: unknown };
  } catch {
    // An incomplete dead-owner lock is safe to remove only after the stale interval.
  }
  if (typeof owner.pid === "number" && processIsRunning(owner.pid)) return false;
  await unlink(lockPath).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
  return true;
};

export const withConfigFileLock = async <T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> => {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const startedAt = Date.now();
  let handle;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, created_at: Date.now() }));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (await removeAbandonedLock(lockPath)) continue;
      if (Date.now() - startedAt >= lockTimeoutMilliseconds) {
        throw new Error("Timed out waiting for the ArtifactPass config lock");
      }
      await delay(lockRetryMilliseconds);
    }
  }

  try {
    return await action();
  } finally {
    await handle.close();
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as { readonly token?: unknown };
      if (owner.token === token) await unlink(lockPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
};

export const writeConfigFileAtomically = async (
  path: string,
  contents: string,
): Promise<void> => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};
