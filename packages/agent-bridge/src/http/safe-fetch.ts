import { artifactErrorSchema } from "artifact-protocol";

import {
  fetchCloudflareDeploymentRoute,
  type CloudflareRouteFetchDependencies,
} from "./cloudflare-route-fetch";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const defaultFetchTimeoutMs = 60_000;

const parseIpv4 = (hostname: string): readonly number[] | undefined => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return undefined;
  }
  return octets;
};

const isLocalIpv4 = (hostname: string): boolean => {
  const octets = parseIpv4(hostname);
  if (octets === undefined) return false;
  const [first = -1, second = -1] = octets;
  return first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
};

const isNonPublicIpv4 = (hostname: string): boolean => {
  const octets = parseIpv4(hostname);
  if (octets === undefined) return false;
  const [first = -1] = octets;
  return isLocalIpv4(hostname) || first === 0 || first >= 224;
};

const isLocalIpv6 = (hostname: string): boolean => {
  if (hostname === "::1") return true;
  if (!hostname.includes(":")) return false;
  const firstHextet = Number.parseInt(hostname.split(":", 1)[0] ?? "", 16);
  return (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf);
};

const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  isLocalIpv4(hostname) ||
  isLocalIpv6(hostname);

const isNonPublicHostname = (hostname: string): boolean =>
  isLocalHostname(hostname) || isNonPublicIpv4(hostname);

export interface FetchWithoutRedirectsOptions extends Pick<CloudflareRouteFetchDependencies, "resolve4"> {
  readonly timeoutMs?: number;
}

export interface DeploymentOriginOptions {
  readonly openDevelopment?: boolean;
}

export const assertDeploymentOrigin = (
  url: URL,
  options: DeploymentOriginOptions = {},
): URL => {
  const openDevelopment = options.openDevelopment === true;
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(openDevelopment
      ? "ArtifactPass development deployment must be a credential-free local HTTP origin"
      : "ArtifactPass deployment must be a credential-free HTTPS origin");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (openDevelopment && (url.protocol !== "http:" || !isLocalHostname(hostname))) {
    throw new Error("ArtifactPass development deployment must be a credential-free local HTTP origin");
  }
  if (!openDevelopment && url.protocol !== "https:") {
    throw new Error("ArtifactPass deployment must be a credential-free HTTPS origin");
  }
  if (!openDevelopment && isNonPublicHostname(hostname)) {
    throw new Error("ArtifactPass deployment origin must not target a private network");
  }
  return new URL(url.origin);
};

export const assertSafeDeploymentOrigin = (url: URL): URL =>
  assertDeploymentOrigin(url);

export const fetchWithoutRedirects = async (
  fetchImplementation: typeof globalThis.fetch,
  input: URL,
  init: RequestInit = {},
  options: FetchWithoutRedirectsOptions = {},
): Promise<Response> => {
  const timeoutMs = options.timeoutMs ?? defaultFetchTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("ArtifactPass request timeout must be a positive integer");
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal === undefined || init.signal === null
    ? timeoutSignal
    : AbortSignal.any([init.signal, timeoutSignal]);
  const response = await fetchCloudflareDeploymentRoute(
    input,
    { ...init, redirect: "manual", signal },
    {
      fetch: fetchImplementation,
      ...(options.resolve4 === undefined ? {} : { resolve4: options.resolve4 }),
    },
  );
  if (redirectStatuses.has(response.status) || response.redirected) {
    throw new Error("ArtifactPass rejected a redirect response");
  }
  return response;
};

export const responseError = async (response: Response): Promise<Error> => {
  const body: unknown = await response.clone().json().catch(() => undefined);
  const parsed = artifactErrorSchema.safeParse(body);
  if (parsed.success) {
    const detail = parsed.data.error.code === "invalid_expiry"
      ? ` (${parsed.data.error.message})`
      : "";
    return new Error(`ArtifactPass request failed: ${parsed.data.error.code}${detail}`);
  }
  return new Error(`ArtifactPass request failed with status ${response.status}`);
};
