import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

import type { DeviceSigningCredential } from "../auth/credential-store";

import { assertSafeDeploymentOrigin, fetchWithoutRedirects, responseError } from "../http/safe-fetch";

export interface DeviceFlowResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly deviceSigning?: DeviceSigningCredential;
}

export interface PendingDeviceAuthorization {
  readonly approvalUrl: string;
  readonly userCode: string;
  readonly expiresAt: number;
  waitForApproval(): Promise<DeviceFlowResult>;
}

export interface DeviceAuthorizationDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly agentName?: string;
  readonly workspaceIdentity?: string;
}

interface DeviceResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

const base64Url = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const createDeviceSigningCredential = (): DeviceSigningCredential => {
  const pair = generateKeyPairSync("ed25519");
  const publicSpki = pair.publicKey.export({ format: "der", type: "spki" });
  const publicRaw = publicSpki.subarray(publicSpki.byteLength - 32);
  const publicKeyBase64 = publicRaw.toString("base64");
  return {
    keyId: `dk_${createHash("sha256").update(publicRaw).digest("base64url")}`,
    publicKeyBase64,
    privateKeyPkcs8Base64: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
};

export const startDeviceAuthorization = async (
  baseUrl: URL | string,
  dependencies: DeviceAuthorizationDependencies = {},
): Promise<PendingDeviceAuthorization> => {
  const origin = assertSafeDeploymentOrigin(new URL(baseUrl));
  const verifier = base64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const deviceSigning = createDeviceSigningCredential();
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const deviceResponse = await fetchWithoutRedirects(
    fetchImplementation,
    new URL("/connect/device", origin),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code_challenge: challenge,
        code_challenge_method: "S256",
        device_key_id: deviceSigning.keyId,
        device_public_key: deviceSigning.publicKeyBase64,
        agent_name: dependencies.agentName ?? "ArtifactPass agent",
        workspace_identity: dependencies.workspaceIdentity ?? "Current workspace",
      }),
    },
  );
  if (!deviceResponse.ok) throw await responseError(deviceResponse);
  const device = await deviceResponse.json() as DeviceResponse;
  const approval = new URL(device.verification_uri);
  const approvalOrigin = assertSafeDeploymentOrigin(new URL(approval.origin));
  if (
    approvalOrigin.origin !== origin.origin ||
    approval.username !== "" ||
    approval.password !== "" ||
    approval.pathname !== "/connect/approve" ||
    approval.hash !== ""
  ) {
    throw new Error("ArtifactPass approval URL must use the configured deployment origin");
  }
  approval.searchParams.set("user_code", device.user_code);
  approval.searchParams.set("format", "html");
  const expiresAt = now() + device.expires_in * 1000;
  const tokenUrl = new URL("/connect/token", origin);
  const tokenRequestBody = JSON.stringify({
    device_code: device.device_code,
    code_verifier: verifier,
  });
  const assertNotAborted = (): void => {
    if (dependencies.signal?.aborted === true) throw new Error("Connection was interrupted");
  };

  return {
    approvalUrl: approval.toString(),
    userCode: device.user_code,
    expiresAt,
    waitForApproval: async () => {
      let interval = device.interval;
      while (now() < expiresAt) {
        assertNotAborted();
        await (dependencies.wait ?? wait)(interval * 1000);
        assertNotAborted();
        let tokenResponse: Response;
        try {
          tokenResponse = await fetchWithoutRedirects(
            fetchImplementation,
            tokenUrl,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: tokenRequestBody,
              ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
            },
          );
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          continue;
        }
        if (tokenResponse.status === 202) {
          const pending = await tokenResponse.json() as { readonly interval?: number };
          interval = pending.interval ?? interval;
          continue;
        }
        if (tokenResponse.status === 429) {
          interval += 5;
          continue;
        }
        if (!tokenResponse.ok) throw await responseError(tokenResponse);
        const token = await tokenResponse.json() as {
          readonly access_token: string;
          readonly expires_in: number;
        };
        return { accessToken: token.access_token, expiresIn: token.expires_in, deviceSigning };
      }
      throw new Error("Device authorization expired before approval");
    },
  };
};

export const completeDeviceFlow = async (
  baseUrl: URL | string,
  dependencies: DeviceAuthorizationDependencies & {
    readonly openBrowser: (url: string) => Promise<void>;
    readonly onManualApprovalRequired?: (url: string) => Promise<void> | void;
  },
): Promise<DeviceFlowResult> => {
  const authorization = await startDeviceAuthorization(baseUrl, dependencies);
  try {
    await dependencies.openBrowser(authorization.approvalUrl);
  } catch (error) {
    if (dependencies.onManualApprovalRequired === undefined) throw error;
    await dependencies.onManualApprovalRequired(authorization.approvalUrl);
  }
  return authorization.waitForApproval();
};
