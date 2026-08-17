import type { ArtifactRepository } from "../storage/artifact-repository";
import type { ArtifactObjectStore } from "../storage/r2-object-store";

export interface ExpireArtifactsResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly failed: number;
}

export const expireArtifacts = async (options: {
  readonly repository: ArtifactRepository;
  readonly objectStore: ArtifactObjectStore;
  readonly now: number;
  readonly limit?: number;
}): Promise<ExpireArtifactsResult> => {
  if (
    options.repository.findLegacyDerivedCandidates !== undefined &&
    options.repository.clearLegacyDerivedObject !== undefined
  ) {
    const legacy = await options.repository.findLegacyDerivedCandidates(options.limit ?? 100);
    for (const artifact of legacy) {
      if (artifact.legacyDerivedObjectKey === null) continue;
      try {
        await options.objectStore.delete(artifact.legacyDerivedObjectKey);
        await options.repository.clearLegacyDerivedObject(artifact.id);
      } catch {
        // Leave the private object key recorded so the next scheduled run retries it.
      }
    }
  }
  const candidates = await options.repository.findCleanupCandidates(
    options.now,
    options.limit ?? 100,
  );
  let deleted = 0;
  let failed = 0;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      const artifact = candidates[nextIndex];
      nextIndex += 1;
      if (artifact === undefined) return;
      try {
        await options.repository.markCleanupPending(artifact.id);
        await options.objectStore.delete(artifact.objectKey);
        if (artifact.derivedObjectKey !== null) {
          await options.objectStore.delete(artifact.derivedObjectKey);
        }
        if (artifact.legacyDerivedObjectKey !== null) {
          await options.objectStore.delete(artifact.legacyDerivedObjectKey);
        }
        await options.repository.delete(artifact.id);
        deleted += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : "Unknown cleanup failure";
        await options.repository.recordCleanupFailure(artifact.id, message).catch(() => undefined);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(5, candidates.length) },
    async () => worker(),
  ));

  return { scanned: candidates.length, deleted, failed };
};
