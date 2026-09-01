import {
  bindAgentCredential,
  resolveAgentCredential,
  type CredentialStore,
} from "../auth/credential-store";
import { fetchWithoutRedirects, responseError } from "../http/safe-fetch";
import {
  startDeviceAuthorization,
  type PendingDeviceAuthorization,
} from "./device-authorization";
import { openBrowser, type BrowserOpener } from "./open-browser";

export interface ConnectionState {
  readonly status: "disconnected" | "connecting" | "connected" | "failed";
  readonly profile: string;
  readonly origin: string;
  readonly expires_at?: number;
  readonly user_code?: string;
  readonly approval_url?: string;
  readonly browser_opened?: boolean;
  readonly message?: string;
}

export interface ConnectionController {
  status(): Promise<ConnectionState>;
  connect(): Promise<ConnectionState>;
}

export interface ConnectionControllerOptions {
  readonly origin: URL;
  readonly profileName: string;
  readonly credentialStore: CredentialStore;
  readonly startDeviceAuthorization?: () => Promise<PendingDeviceAuthorization>;
  readonly openBrowser?: BrowserOpener;
  readonly inspectCredential?: (token: string) => Promise<{ readonly expiresAt: number } | null>;
  readonly revokeCredential?: (token: string) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly agentName?: string;
  readonly workspaceIdentity?: string;
}

const safeMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "ArtifactPass connection failed";

export const createConnectionController = (
  options: ConnectionControllerOptions,
): ConnectionController => {
  const origin = options.origin.origin;
  const now = options.now ?? Date.now;
  let current: ConnectionState | undefined;
  let connectStart: Promise<ConnectionState> | undefined;
  let backgroundFailurePending = false;

  const base = () => ({ profile: options.profileName, origin });
  const inspectCredential = options.inspectCredential ?? (async (token: string) => {
    const response = await fetchWithoutRedirects(
      options.fetch ?? globalThis.fetch,
      new URL("/api/connection", options.origin),
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (response.status === 401 || response.status === 404) return null;
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as {
      readonly status?: string;
      readonly scope?: string;
      readonly expires_at?: number;
    };
    if (
      body.status !== "active" ||
      body.scope !== "artifact:create" ||
      typeof body.expires_at !== "number"
    ) {
      throw new Error("ArtifactPass returned an invalid connection status");
    }
    return { expiresAt: body.expires_at };
  });
  const revokeCredential = options.revokeCredential ?? (async (token: string) => {
    const response = await fetchWithoutRedirects(
      options.fetch ?? globalThis.fetch,
      new URL("/api/connection", options.origin),
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok && response.status !== 404) throw await responseError(response);
  });

  const status = async (): Promise<ConnectionState> => {
    if (current?.status === "connecting") return current;
    if (current?.status === "failed" && backgroundFailurePending) {
      backgroundFailurePending = false;
      return current;
    }
    let stored: string | null;
    try {
      stored = await options.credentialStore.get();
    } catch (error) {
      current = { status: "failed", ...base(), message: safeMessage(error) };
      return current;
    }
    if (stored === null) {
      current = { status: "disconnected", ...base() };
      return current;
    }
    try {
      const token = resolveAgentCredential(stored, options.origin);
      const inspected = await inspectCredential(token);
      current = inspected === null || inspected.expiresAt <= now()
        ? { status: "disconnected", ...base() }
        : { status: "connected", ...base(), expires_at: inspected.expiresAt };
    } catch (error) {
      current = { status: "failed", ...base(), message: safeMessage(error) };
    }
    return current;
  };

  const beginConnect = async (): Promise<ConnectionState> => {
    const existing = await status();
    if (existing.status === "connected" || existing.status === "connecting") return existing;
    current = undefined;
    let authorization: PendingDeviceAuthorization;
    try {
      authorization = await (
        options.startDeviceAuthorization ?? (() => startDeviceAuthorization(options.origin, {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          now,
          ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
          ...(options.workspaceIdentity === undefined ? {} : { workspaceIdentity: options.workspaceIdentity }),
        }))
      )();
    } catch (error) {
      current = { status: "failed", ...base(), message: safeMessage(error) };
      return current;
    }
    let browserOpened = true;
    try {
      await (options.openBrowser ?? openBrowser)(authorization.approvalUrl);
    } catch {
      browserOpened = false;
    }
    current = {
      status: "connecting",
      ...base(),
      expires_at: authorization.expiresAt,
      user_code: authorization.userCode,
      approval_url: authorization.approvalUrl,
      browser_opened: browserOpened,
    };
    void authorization.waitForApproval()
      .then(async ({ accessToken, expiresIn, deviceSigning }) => {
        try {
          await options.credentialStore.set(bindAgentCredential(options.origin, accessToken, deviceSigning));
        } catch (persistenceError) {
          try {
            await revokeCredential(accessToken);
          } catch (revocationError) {
            throw new AggregateError(
              [persistenceError, revocationError],
              "ArtifactPass credential could not be saved and the issued token could not be revoked",
            );
          }
          throw persistenceError;
        }
        current = {
          status: "connected",
          ...base(),
          expires_at: now() + expiresIn * 1000,
        };
      })
      .catch((error: unknown) => {
        current = { status: "failed", ...base(), message: safeMessage(error) };
        backgroundFailurePending = true;
      });
    return current;
  };

  const connect = (): Promise<ConnectionState> => {
    if (current?.status === "connecting") return Promise.resolve(current);
    if (connectStart !== undefined) return connectStart;
    const started = beginConnect();
    connectStart = started;
    void started.then(
      () => { if (connectStart === started) connectStart = undefined; },
      () => { if (connectStart === started) connectStart = undefined; },
    );
    return started;
  };

  return { status, connect };
};
