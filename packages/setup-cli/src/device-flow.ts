import { createHash, randomBytes } from "node:crypto";

import { assertSafeDeploymentOrigin, fetchWithoutRedirects, responseError } from "agent-bridge";

export interface DeviceFlowResult {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export interface DeviceFlowDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
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

export const completeDeviceFlow = async (
  baseUrl: string,
  dependencies: DeviceFlowDependencies,
): Promise<DeviceFlowResult> => {
  const origin = assertSafeDeploymentOrigin(new URL(baseUrl));
  const verifier = base64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const deviceResponse = await fetchWithoutRedirects(
    fetchImplementation,
    new URL("/connect/device", origin),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
    },
  );
  if (!deviceResponse.ok) throw await responseError(deviceResponse);
  const device = await deviceResponse.json() as DeviceResponse;
  const approval = new URL(device.verification_uri);
  approval.searchParams.set("user_code", device.user_code);
  approval.searchParams.set("format", "html");
  await dependencies.openBrowser(approval.toString());

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval;
  while (Date.now() < deadline) {
    if (dependencies.signal?.aborted === true) throw new Error("Connection was interrupted");
    await (dependencies.wait ?? wait)(interval * 1000);
    const tokenResponse = await fetchWithoutRedirects(
      fetchImplementation,
      new URL("/connect/token", origin),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: device.device_code, code_verifier: verifier }),
      },
    );
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
    return { accessToken: token.access_token, expiresIn: token.expires_in };
  }
  throw new Error("Device authorization expired before approval");
};
