import { mkdir, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { DeploymentResult } from "../cloudflare/deployment";
import type { PrivateDeploymentSpecification } from "./deployment-specification";

export const privateDeploymentReceiptVersion = 1 as const;

export interface PrivateDeploymentReceipt {
  readonly version: typeof privateDeploymentReceiptVersion;
  readonly product: "ArtifactPass";
  readonly status: "verified";
  readonly deployment_id: string;
  readonly hostname: string;
  readonly origin: string;
  readonly service_name: string;
  readonly cloudflare: {
    readonly account_id: string;
    readonly zone_id: string;
    readonly placement: "automatic";
  };
  readonly resources: Readonly<Record<string, string>>;
  readonly identity_mode: "email-code" | "company-login";
  readonly allowed_expiry_seconds: readonly number[];
  readonly verification: {
    readonly health: "passed";
    readonly protected_upload: "passed";
    readonly verified_at: string;
  };
  readonly setup_command: string;
  readonly disclosure: "Anyone with a live ArtifactPass link can read that artifact until it expires.";
  readonly completed_at: string;
}

const secretKey = /(?:token|secret|private[_-]?key|authorization|share[_-]?url)/iu;
const capabilityPath = /\/a\/[A-Za-z0-9_-]{20,}/u;

const assertRedacted = (value: unknown, path = "receipt"): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRedacted(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (secretKey.test(key)) throw new Error(`Private deployment receipt cannot contain ${path}.${key}`);
      assertRedacted(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && (capabilityPath.test(value) || value.startsWith("/"))) {
    throw new Error(`Private deployment receipt contains an unsafe value at ${path}`);
  }
};

export const validatePrivateDeploymentReceipt = (value: PrivateDeploymentReceipt): PrivateDeploymentReceipt => {
  if (
    value.version !== privateDeploymentReceiptVersion || value.product !== "ArtifactPass" ||
    value.status !== "verified" || value.verification.health !== "passed" ||
    value.verification.protected_upload !== "passed" ||
    !value.setup_command.includes(`--base-url ${value.origin}`)
  ) {
    throw new Error("Private deployment receipt is incomplete or unsupported");
  }
  assertRedacted(value);
  return value;
};

export const createPrivateDeploymentReceipt = (
  specification: PrivateDeploymentSpecification,
  result: DeploymentResult,
  now: Date = new Date(),
): PrivateDeploymentReceipt => {
  if (result.verification?.health !== "passed" || result.verification.protectedUpload !== "passed") {
    throw new Error("A private deployment receipt requires successful hosted verification");
  }
  return validatePrivateDeploymentReceipt({
    version: privateDeploymentReceiptVersion,
    product: "ArtifactPass",
    status: "verified",
    deployment_id: specification.deployment_id,
    hostname: specification.hostname,
    origin: result.baseUrl,
    service_name: specification.service_name,
    cloudflare: {
      account_id: specification.account_id,
      zone_id: specification.zone_id,
      placement: specification.placement,
    },
    resources: result.resources ?? {},
    identity_mode: specification.identity.mode,
    allowed_expiry_seconds: specification.retention.allowed_expiry_seconds,
    verification: {
      health: "passed",
      protected_upload: "passed",
      verified_at: result.verification.verifiedAt,
    },
    setup_command: result.teamCommand,
    disclosure: "Anyone with a live ArtifactPass link can read that artifact until it expires.",
    completed_at: now.toISOString(),
  });
};

export const writePrivateDeploymentReceipt = async (
  root: string,
  receipt: PrivateDeploymentReceipt,
): Promise<string> => {
  validatePrivateDeploymentReceipt(receipt);
  const path = resolve(root, "receipts", `${receipt.deployment_id}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  return path;
};
