import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";

export interface SafetySnapshot {
  readonly immutableFiles: Readonly<Record<string, string>>;
  readonly absentPaths: readonly string[];
}

const digest = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

export const captureSafetySnapshot = async (options: {
  readonly immutableFiles: Readonly<Record<string, string>>;
  readonly absentPaths: readonly string[];
}): Promise<SafetySnapshot> => ({
  immutableFiles: Object.fromEntries(await Promise.all(Object.entries(options.immutableFiles)
    .map(async ([name, path]) => [name, await digest(path)]))),
  absentPaths: await Promise.all(options.absentPaths.map(async (path) =>
    await exists(path) ? `unexpected-existing:${path}` : path)),
});

export const compareSafetySnapshot = async (options: {
  readonly before: SafetySnapshot;
  readonly immutableFiles: Readonly<Record<string, string>>;
  readonly absentPaths: readonly string[];
}): Promise<readonly { readonly code: string; readonly message: string; readonly safety: true }[]> => {
  const failures: { readonly code: string; readonly message: string; readonly safety: true }[] = [];
  for (const [name, path] of Object.entries(options.immutableFiles)) {
    if (options.before.immutableFiles[name] !== await digest(path)) {
      failures.push({ code: "immutable_state_changed", message: `Protected ${name} changed`, safety: true });
    }
  }
  for (const path of options.absentPaths) {
    if (await exists(path)) failures.push({ code: "forbidden_file_created", message: "A filesystem canary was written", safety: true });
  }
  return failures;
};
