import { artifactErrorSchema } from "artifact-protocol";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const isPrivateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224;
};

export const assertSafeDeploymentOrigin = (url: URL): URL => {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Artifact Share deployment must be a credential-free HTTPS origin");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe8") ||
    hostname.startsWith("fe9") ||
    hostname.startsWith("fea") ||
    hostname.startsWith("feb") ||
    isPrivateIpv4(hostname)
  ) {
    throw new Error("Artifact Share deployment origin must not target a private network");
  }
  return new URL(url.origin);
};

export const fetchWithoutRedirects = async (
  fetchImplementation: typeof globalThis.fetch,
  input: URL,
  init: RequestInit = {},
): Promise<Response> => {
  const response = await fetchImplementation(input, { ...init, redirect: "manual" });
  if (redirectStatuses.has(response.status) || response.redirected) {
    throw new Error("Artifact Share rejected a redirect response");
  }
  return response;
};

export const responseError = async (response: Response): Promise<Error> => {
  const body: unknown = await response.clone().json().catch(() => undefined);
  const parsed = artifactErrorSchema.safeParse(body);
  if (parsed.success) {
    return new Error(`Artifact Share request failed: ${parsed.data.error.code}`);
  }
  return new Error(`Artifact Share request failed with status ${response.status}`);
};
