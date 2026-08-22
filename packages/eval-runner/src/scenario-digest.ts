import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const scenarioDigest = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");
