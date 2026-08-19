import { join } from "node:path";

import { portableIntegrationDigest } from "../../setup-cli/src/portable-integration";

export const candidateDigest = async (repositoryRoot: string): Promise<string> =>
  portableIntegrationDigest(join(repositoryRoot, "plugins/artifactpass"));
