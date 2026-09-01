import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

const retryableDnsCodes = new Set(["EAI_AGAIN", "ENOTFOUND"]);
const maximumResponseBytes = 2 * 1024 * 1024;

const errorCode = (error: unknown): string | undefined => {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error && "cause" in error) return errorCode(error.cause);
  return undefined;
};

const isPublicIpv4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [first = -1, second = -1, third = -1] = octets;
  return !(
    first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
};

const resolveWithSignal = async (
  resolve4: () => Promise<readonly string[]>,
  signal: AbortSignal | null | undefined,
  cancel?: () => void,
): Promise<readonly string[]> => {
  if (signal === undefined || signal === null) return resolve4();
  if (signal.aborted) throw signal.reason;
  return await new Promise<readonly string[]>((resolve, reject) => {
    const onAbort = () => {
      cancel?.();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    resolve4().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

const responseThroughAddress = async (
  normalized: Request,
  address: string,
  redirect: RequestInit["redirect"],
  requestImplementation: typeof httpsRequest,
): Promise<Response> => {
  if (!isPublicIpv4(address)) throw new Error("ArtifactPass DNS fallback rejected a non-public address");
  const url = new URL(normalized.url);
  const body = normalized.body === null ? undefined : Buffer.from(await normalized.arrayBuffer());
  return await new Promise<Response>((resolve, reject) => {
    const lookup = ((_hostname, options, callback) => {
      if (typeof options === "object" && options.all) {
        callback(null, [{ address, family: 4 }]);
        return;
      }
      callback(null, address, 4);
    }) as LookupFunction;
    const request = requestImplementation(url, {
      method: normalized.method,
      headers: Object.fromEntries(normalized.headers.entries()),
      lookup,
      signal: normalized.signal,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumResponseBytes) {
          request.destroy(new Error("ArtifactPass response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        const status = incoming.statusCode ?? 500;
        if (redirect === "error" && status >= 300 && status < 400) {
          reject(new Error("ArtifactPass route redirected unexpectedly"));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const responseBody = status === 204 || status === 205 || status === 304
          ? null
          : Buffer.concat(chunks);
        resolve(new Response(responseBody, { status, headers }));
      });
    });
    request.on("error", reject);
    request.end(body);
  });
};

export interface CloudflareRouteFetchDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly resolve4?: (hostname: string) => Promise<readonly string[]>;
  readonly requestHttps?: typeof httpsRequest;
}

export const fetchCloudflareDeploymentRoute = async (
  request: string | URL | Request,
  init: RequestInit = {},
  dependencies: CloudflareRouteFetchDependencies = {},
): Promise<Response> => {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const fallbackRequest = request instanceof Request
    ? new Request(request.clone(), init)
    : new Request(request, init);
  try {
    return await fetchImplementation(request, init);
  } catch (error) {
    if (!retryableDnsCodes.has(errorCode(error) ?? "")) throw error;
    const url = new URL(fallbackRequest.url);
    if (url.protocol !== "https:") throw error;
    const resolver = dependencies.resolve4 === undefined ? new Resolver() : undefined;
    resolver?.setServers(["1.1.1.1", "1.0.0.1"]);
    const resolve4 = dependencies.resolve4 ?? (async (hostname: string) => await resolver!.resolve4(hostname));
    const addresses = await resolveWithSignal(
      () => resolve4(url.hostname),
      fallbackRequest.signal,
      resolver === undefined ? undefined : () => resolver.cancel(),
    );
    const address = addresses.find(isPublicIpv4);
    if (address === undefined) throw new Error("ArtifactPass DNS fallback found no public address");
    return await responseThroughAddress(
      fallbackRequest,
      address,
      init.redirect,
      dependencies.requestHttps ?? httpsRequest,
    );
  }
};
