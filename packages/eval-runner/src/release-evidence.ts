import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

export const releaseEvidenceManifestSchema = z.object({
  version: z.literal(1),
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  created_at: z.iso.datetime({ offset: true }),
  reports: z.array(z.string().min(1)).min(1),
  cohorts: z.array(z.string().min(1)).min(1),
}).strict();

export type ReleaseEvidenceManifest = z.infer<typeof releaseEvidenceManifestSchema>;

const containedTarget = async (root: string, reference: string): Promise<string> => {
  if (isAbsolute(reference)) throw new Error("Release evidence references must be relative");
  const target = await realpath(resolve(root, reference));
  const relativeTarget = relative(await realpath(root), target);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) throw new Error("Release evidence reference escaped its bundle");
  return target;
};

export const loadReleaseEvidenceManifest = async (path: string): Promise<{
  readonly manifest: ReleaseEvidenceManifest;
  readonly reports: readonly string[];
  readonly cohorts: readonly string[];
}> => {
  const manifestPath = await realpath(path);
  const root = dirname(manifestPath);
  const manifest = releaseEvidenceManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const [reports, cohorts] = await Promise.all([
    Promise.all(manifest.reports.map((reference) => containedTarget(root, reference))),
    Promise.all(manifest.cohorts.map((reference) => containedTarget(root, reference))),
  ]);
  return { manifest, reports, cohorts };
};
