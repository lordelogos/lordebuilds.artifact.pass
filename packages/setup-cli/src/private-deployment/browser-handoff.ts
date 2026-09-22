export type BrowserHandoffCheck =
  | { readonly status: "ready"; readonly evidence: Readonly<Record<string, unknown>> }
  | { readonly status: "pending"; readonly message: string; readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: "permission-denied"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string };

export type BrowserHandoffResult =
  | { readonly status: "ready"; readonly evidence: Readonly<Record<string, unknown>>; readonly checked_at: string }
  | { readonly status: "saved" | "cancelled" | "timeout" | "permission-denied" | "conflict" | "browser-open-failed"; readonly message: string };

import { promptForChoice, type TerminalPrompt } from "../terminal-prompt";

export type BrowserHandoffPrompt = TerminalPrompt;

export interface BrowserHandoffInput {
  readonly title: string;
  readonly purpose: string;
  readonly cloudflareChange: string;
  readonly artifactpassReads: string;
  readonly readiness: string;
  readonly url: string;
  readonly guideUrl?: string;
  readonly resumed?: boolean;
  readonly timeoutMilliseconds?: number;
}

export interface BrowserHandoffDependencies {
  readonly prompt: BrowserHandoffPrompt;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly copyLink?: (url: string) => Promise<void>;
  readonly check: () => Promise<BrowserHandoffCheck>;
  readonly now?: () => number;
  readonly isoNow?: () => string;
}

const renderIntroduction = (input: BrowserHandoffInput): string => [
  input.title,
  input.resumed === true ? "Resuming this Cloudflare step." : undefined,
  `Why this page is needed: ${input.purpose}`,
  `What changes in Cloudflare: ${input.cloudflareChange}`,
  `What ArtifactPass reads afterward: ${input.artifactpassReads}`,
  `Ready when: ${input.readiness}`,
  input.guideUrl === undefined ? undefined : `Step-by-step guide: ${input.guideUrl}`,
  `Cloudflare page: ${input.url}`,
].filter((line) => line !== undefined).join("\n");

const askAction = async (prompt: BrowserHandoffPrompt): Promise<"open" | "check" | "save" | "copy" | "cancel"> => {
  const actions = ["open", "check", "save", "copy", "cancel"] as const;
  return actions[await promptForChoice(prompt, "What would you like to do?", [
    "Open Cloudflare",
    "Check again",
    "Save and exit",
    "Copy link",
    "Cancel current action",
  ])] as (typeof actions)[number];
};

export const runBrowserHandoff = async (
  input: BrowserHandoffInput,
  dependencies: BrowserHandoffDependencies,
): Promise<BrowserHandoffResult> => {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const timeoutMilliseconds = input.timeoutMilliseconds ?? 15 * 60_000;
  if (dependencies.prompt.note === undefined) dependencies.prompt.write(`${renderIntroduction(input)}\n\n`);
  else dependencies.prompt.note(renderIntroduction(input).split("\n").slice(1).join("\n"), input.title);
  let browserOpenFailed: string | undefined;
  for (;;) {
    if (now() - startedAt >= timeoutMilliseconds) {
      return {
        status: "timeout",
        message: `Cloudflare is still pending. Save the deployment and resume after this is true: ${input.readiness}`,
      };
    }
    const action = await askAction(dependencies.prompt);
    if (action === "save") {
      return { status: "saved", message: `Progress is saved. Resume after this is true: ${input.readiness}` };
    }
    if (action === "cancel") {
      return { status: "cancelled", message: "The current Cloudflare action was cancelled. Proven deployment progress is unchanged." };
    }
    if (action === "copy") {
      if (dependencies.copyLink === undefined) {
        dependencies.prompt.write(`${input.url}\n`);
      } else {
        await dependencies.copyLink(input.url);
        dependencies.prompt.write("Cloudflare link copied.\n");
      }
      continue;
    }
    if (action === "open") {
      dependencies.prompt.write("Opening Cloudflare…\n");
      try {
        await dependencies.openBrowser(input.url);
        browserOpenFailed = undefined;
        dependencies.prompt.write("Cloudflare is open. Complete the step there, then choose Check again.\n");
      } catch (error) {
        browserOpenFailed = error instanceof Error ? error.message : "The browser could not be opened";
        dependencies.prompt.write(`ArtifactPass could not open the browser. Copy this link instead: ${input.url}\n`);
      }
      continue;
    }
    dependencies.prompt.write("Checking Cloudflare…\n");
    const result = await dependencies.check();
    if (result.status === "ready") {
      return {
        status: "ready",
        evidence: result.evidence,
        checked_at: (dependencies.isoNow ?? (() => new Date().toISOString()))(),
      };
    }
    if (result.status === "permission-denied" || result.status === "conflict") {
      return { status: result.status, message: result.message };
    }
    dependencies.prompt.write(`Still pending: ${result.message}\n`);
    if (browserOpenFailed !== undefined) {
      return { status: "browser-open-failed", message: `${browserOpenFailed}. ${result.message}` };
    }
  }
};

export const describeBrowserHandoff = renderIntroduction;
