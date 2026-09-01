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

const responseThroughAddress = async (
  url: URL,
  address: string,
  init: RequestInit,
): Promise<Response> => await new Promise<Response>((resolve, reject) => {
  const lookup = ((_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family: 4 }]);
      return;
    }
    callback(null, address, 4);
  }) as LookupFunction;
  const request = httpsRequest(url, {
    method: init.method ?? "GET",
    headers: init.headers === undefined ? undefined : Object.fromEntries(new Headers(init.headers).entries()),
    lookup,
    signal: init.signal ?? undefined,
  }, (incoming) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumResponseBytes) {
        request.destroy(new Error("Deployment readiness response is too large"));
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      const status = incoming.statusCode ?? 500;
      if (init.redirect === "error" && status >= 300 && status < 400) {
        reject(new Error("Deployment readiness route redirected unexpectedly"));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      resolve(new Response(Buffer.concat(chunks), { status, headers }));
    });
  });
  request.on("error", reject);
  request.end();
});

export interface DeploymentReadinessFetchDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly resolve4?: (hostname: string) => Promise<readonly string[]>;
}

export const fetchCloudflareDeploymentRoute = async (
  request: string | URL | Request,
  init: RequestInit = {},
  dependencies: DeploymentReadinessFetchDependencies = {},
): Promise<Response> => {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  try {
    return await fetchImplementation(request, init);
  } catch (error) {
    if (!retryableDnsCodes.has(errorCode(error) ?? "")) throw error;
    const url = new URL(request instanceof Request ? request.url : request);
    if (url.protocol !== "https:") throw error;
    const resolve4 = dependencies.resolve4 ?? (async (hostname: string) => {
      const resolver = new Resolver();
      resolver.setServers(["1.1.1.1", "1.0.0.1"]);
      return await resolver.resolve4(hostname);
    });
    const addresses = await resolve4(url.hostname);
    const address = addresses[0];
    if (address === undefined) throw error;
    return await responseThroughAddress(url, address, init);
  }
};
