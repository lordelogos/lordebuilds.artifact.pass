export interface CloudflareEnvelope<T> {
  readonly success: boolean;
  readonly result: T;
  readonly errors?: readonly { readonly code: number; readonly message: string }[];
}

export interface CloudflareClientOptions {
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiOrigin?: string;
}

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
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.apiOrigin = options.apiOrigin ?? "https://api.cloudflare.com/client/v4/";
  }

  public async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImplementation(new URL(path.replace(/^\//u, ""), this.apiOrigin), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      redirect: "error",
    });
    const envelope = await response.json().catch(() => null) as CloudflareEnvelope<T> | null;
    if (!response.ok || envelope?.success !== true) {
      const first = envelope?.errors?.[0];
      throw new CloudflareApiError(
        first?.message ?? `Cloudflare API request failed (${response.status})`,
        response.status,
        first?.code,
      );
    }
    return envelope.result;
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
