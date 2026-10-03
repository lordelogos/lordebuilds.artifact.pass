import { stat } from "node:fs/promises";

import { openBrowser, type BrowserOpener } from "./open-browser";
import {
  startWorkspaceApprovalServer,
  type PendingWorkspaceApprovalServer,
} from "./workspace-approval-server";

export interface WorkspaceApprovalRequest {
  readonly workspaceRoot: string;
  readonly proposedOrigin: string;
  readonly availableOrigins: readonly string[];
}

export interface WorkspaceApprovalControllerOptions {
  readonly approve: (request: WorkspaceApprovalRequest, origin: string) => Promise<void>;
  readonly openBrowser?: BrowserOpener;
  readonly timeoutMilliseconds?: number;
}

export interface WorkspaceApprovalState {
  readonly status: "connecting" | "failed";
  readonly authentication_status: "unknown";
  readonly workspace_status: "required";
  readonly ready_to_publish: false;
  readonly workspace_root: string;
  readonly proposed_origin: string;
  readonly phase: "workspace_approval";
  readonly approval_url?: string;
  readonly browser_opened?: boolean;
  readonly expires_at?: number;
  readonly error_code?: string;
  readonly message?: string;
  readonly next_action?: string;
}

export interface WorkspaceApprovalController {
  status(request: WorkspaceApprovalRequest): WorkspaceApprovalState | undefined;
  connect(request: WorkspaceApprovalRequest): Promise<WorkspaceApprovalState>;
  close(): Promise<void>;
}

const keyFor = (request: WorkspaceApprovalRequest): string =>
  JSON.stringify([request.workspaceRoot, request.proposedOrigin]);

export const createWorkspaceApprovalController = (
  options: WorkspaceApprovalControllerOptions,
): WorkspaceApprovalController => {
  const attempts = new Map<string, {
    readonly server?: PendingWorkspaceApprovalServer;
    state: WorkspaceApprovalState;
  }>();

  const rememberFailedAttempt = (
    key: string,
    state: WorkspaceApprovalState,
  ): void => {
    attempts.delete(key);
    attempts.set(key, { state });
    const failedKeys = [...attempts.entries()]
      .filter(([, attempt]) => attempt.state.status === "failed")
      .map(([attemptKey]) => attemptKey);
    for (const expiredKey of failedKeys.slice(0, -32)) attempts.delete(expiredKey);
  };

  const connect = async (request: WorkspaceApprovalRequest): Promise<WorkspaceApprovalState> => {
    const key = keyFor(request);
    const existing = attempts.get(key);
    if (existing?.state.status === "connecting") return existing.state;
    attempts.delete(key);
    const initialWorkspace = await stat(request.workspaceRoot);
    if (!initialWorkspace.isDirectory()) {
      throw new Error("ArtifactPass workspace_root must name a directory");
    }
    const server = await startWorkspaceApprovalServer({
      ...request,
      approve: async (origin) => {
        const currentWorkspace = await stat(request.workspaceRoot);
        if (
          !currentWorkspace.isDirectory() ||
          currentWorkspace.dev !== initialWorkspace.dev ||
          currentWorkspace.ino !== initialWorkspace.ino
        ) {
          throw new Error("The project folder changed while approval was open. Start approval again.");
        }
        await options.approve(request, origin);
      },
      ...(options.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: options.timeoutMilliseconds }),
    });
    let browserOpened = true;
    try {
      await (options.openBrowser ?? openBrowser)(server.approvalUrl);
    } catch {
      browserOpened = false;
    }
    const state: WorkspaceApprovalState = {
      status: "connecting",
      authentication_status: "unknown",
      workspace_status: "required",
      ready_to_publish: false,
      workspace_root: request.workspaceRoot,
      proposed_origin: request.proposedOrigin,
      phase: "workspace_approval",
      approval_url: server.approvalUrl,
      browser_opened: browserOpened,
      expires_at: server.expiresAt,
      next_action: "Review the folder and destination in the browser. The approval link is included for manual opening.",
    };
    attempts.set(key, { server, state });
    void server.result.then((result) => {
      if (result.status === "approved") {
        attempts.delete(key);
        return;
      }
      const errorCode = result.status === "cancelled"
        ? "workspace_approval_cancelled"
        : result.status === "expired"
          ? "workspace_approval_expired"
          : "workspace_approval_failed";
      rememberFailedAttempt(key, {
        ...state,
        status: "failed",
        error_code: errorCode,
        message: result.status === "failed" ? result.message : (
          result.status === "cancelled" ? "Project approval was cancelled." : "Project approval expired."
        ),
        next_action: "Call connect_artifactpass again to start a new approval.",
      });
    });
    return state;
  };

  return {
    status: (request) => attempts.get(keyFor(request))?.state,
    connect,
    close: async () => {
      await Promise.all([...attempts.values()].flatMap((attempt) =>
        attempt.server === undefined ? [] : [attempt.server.close()]));
      attempts.clear();
    },
  };
};
