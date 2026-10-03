import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  renderWorkspaceApprovalPage,
  workspaceApprovalPageHeaders,
} from "./workspace-approval-page";

export type WorkspaceApprovalServerResult =
  | { readonly status: "approved"; readonly origin: string }
  | { readonly status: "cancelled" }
  | { readonly status: "expired" }
  | { readonly status: "failed"; readonly message: string };

export interface WorkspaceApprovalServerOptions {
  readonly workspaceRoot: string;
  readonly proposedOrigin: string;
  readonly availableOrigins: readonly string[];
  readonly approve: (origin: string) => Promise<void>;
  readonly timeoutMilliseconds?: number;
}

export interface PendingWorkspaceApprovalServer {
  readonly approvalUrl: string;
  readonly expiresAt: number;
  readonly result: Promise<WorkspaceApprovalServerResult>;
  close(): Promise<void>;
}

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });

const respond = (
  response: ServerResponse,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = { "content-type": "text/plain; charset=utf-8" },
): void => {
  response.writeHead(status, headers).end(body);
};

const readForm = async (request: IncomingMessage): Promise<URLSearchParams> => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 8 * 1024) throw new Error("Approval request is too large");
  }
  return new URLSearchParams(body);
};

export const startWorkspaceApprovalServer = async (
  options: WorkspaceApprovalServerOptions,
): Promise<PendingWorkspaceApprovalServer> => {
  const token = randomBytes(32).toString("base64url");
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 10 * 60_000;
  const expiresAt = Date.now() + timeoutMilliseconds;
  let settled = false;
  let settle: ((result: WorkspaceApprovalServerResult) => void) | undefined;
  const result = new Promise<WorkspaceApprovalServerResult>((resolveResult) => {
    settle = resolveResult;
  });
  let expectedOrigin = "";
  let expectedHost = "";
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", expectedOrigin);
    if (request.headers.host !== expectedHost || requestUrl.pathname !== "/workspace-approval") {
      respond(response, 404, "Not found");
      return;
    }
    if (request.method === "GET") {
      if (requestUrl.searchParams.get("token") !== token || settled) {
        respond(response, 410, "This approval request is no longer available.");
        return;
      }
      respond(response, 200, renderWorkspaceApprovalPage({
        workspaceRoot: options.workspaceRoot,
        proposedOrigin: options.proposedOrigin,
        availableOrigins: options.availableOrigins,
        token,
        state: "review",
      }), workspaceApprovalPageHeaders());
      return;
    }
    if (request.method !== "POST") {
      respond(response, 405, "Method not allowed", { allow: "GET, POST" });
      return;
    }
    if (request.headers.origin !== expectedOrigin) {
      respond(response, 403, "ArtifactPass rejected an invalid approval origin.");
      return;
    }
    const mediaType = (request.headers["content-type"] ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/x-www-form-urlencoded") {
      respond(response, 415, "Unsupported content type");
      return;
    }
    if (settled) {
      respond(response, 409, "This approval request was already completed.");
      return;
    }
    try {
      const form = await readForm(request);
      if (form.get("token") !== token) {
        respond(response, 403, "ArtifactPass rejected an invalid approval token.");
        return;
      }
      const action = form.get("action");
      if (action === "cancel") {
        settled = true;
        respond(response, 200, renderWorkspaceApprovalPage({
          ...options,
          token,
          state: "cancelled",
        }), workspaceApprovalPageHeaders());
        settle?.({ status: "cancelled" });
        setImmediate(() => void closeServer(server));
        return;
      }
      if (action !== "approve") {
        respond(response, 400, "Choose Allow project or Cancel.");
        return;
      }
      const origin = form.get("origin")?.trim() ?? "";
      await options.approve(origin);
      settled = true;
      respond(response, 200, renderWorkspaceApprovalPage({
        ...options,
        proposedOrigin: origin,
        token,
        state: "approved",
      }), workspaceApprovalPageHeaders());
      settle?.({ status: "approved", origin });
      setImmediate(() => void closeServer(server));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Project access could not be saved";
      respond(response, 409, renderWorkspaceApprovalPage({
        ...options,
        token,
        state: "failed",
        message,
      }), workspaceApprovalPageHeaders());
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("ArtifactPass could not start workspace approval");
  }
  expectedOrigin = `http://127.0.0.1:${address.port}`;
  expectedHost = `127.0.0.1:${address.port}`;
  const approvalUrl = `${expectedOrigin}/workspace-approval?token=${encodeURIComponent(token)}`;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    settle?.({ status: "expired" });
    void closeServer(server);
  }, timeoutMilliseconds);
  timeout.unref?.();
  void result.finally(() => clearTimeout(timeout));
  return {
    approvalUrl,
    expiresAt,
    result,
    close: async () => {
      if (!settled) {
        settled = true;
        settle?.({ status: "failed", message: "Workspace approval was interrupted" });
      }
      clearTimeout(timeout);
      await closeServer(server);
    },
  };
};
