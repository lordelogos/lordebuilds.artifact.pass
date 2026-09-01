export interface CloudflareEnvelope<T> {
  readonly success: boolean;
  readonly result: T;
  readonly errors?: readonly { readonly code: number; readonly message: string }[];
}

export interface CloudflareClientOptions {
  readonly token?: string;
  readonly resolveToken?: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiOrigin?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const readRetryDelays = [500, 1_500, 3_000] as const;

export class CloudflareApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
  ) {
    super(message);
  }
}

export class CloudflareClient {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly apiOrigin: string;

  public constructor(private readonly options: CloudflareClientOptions) {
    if ((options.token === undefined) === (options.resolveToken === undefined)) {
      throw new Error("CloudflareClient requires exactly one token source");
    }
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.apiOrigin = options.apiOrigin ?? "https://api.cloudflare.com/client/v4/";
  }

  public async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.options.resolveToken === undefined
      ? this.options.token as string
      : await this.options.resolveToken();
    const method = (init.method ?? "GET").toUpperCase();
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImplementation(new URL(path.replace(/^\//u, ""), this.apiOrigin), {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
        redirect: "error",
      });
      const envelope = await response.json().catch(() => null) as CloudflareEnvelope<T> | null;
      if (response.ok && envelope?.success === true) return envelope.result;
      const delay = method === "GET" && (response.status === 429 || response.status >= 500)
        ? readRetryDelays[attempt]
        : undefined;
      if (delay !== undefined) {
        await (this.options.sleep ?? (async (milliseconds: number) =>
          await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(delay);
        continue;
      }
      const first = envelope?.errors?.[0];
      throw new CloudflareApiError(
        first?.message ?? `Cloudflare API request failed (${response.status})`,
        response.status,
        first?.code,
      );
    }
  }

  public async verifyToken(): Promise<{ readonly status: string }> {
    try {
      return await this.request("/user/tokens/verify");
    } catch (error) {
      // Wrangler OAuth credentials are valid Cloudflare bearer credentials, but
      // Cloudflare's API-token verification endpoint rejects them with code 1000.
      // A successful authenticated user lookup proves the OAuth session instead.
      if (!(error instanceof CloudflareApiError) || error.code !== 1000) throw error;
      await this.request("/user");
      return { status: "active" };
    }
  }
}
