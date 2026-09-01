import packageMetadata from "../../package.json" with { type: "json" };

import {
  createPrivateDeploymentState,
  invalidatePrivateDeploymentCheckpoints,
  listPrivateDeploymentStates,
  privateDeploymentStateRoot,
  provePrivateDeploymentCheckpoint,
  resolvePrivateDeploymentState,
  withPrivateDeploymentLock,
  writePrivateDeploymentState,
  type PrivateDeploymentState,
  type PrivateSignInMode,
} from "./deployment-state";
import type { PrivateDeploymentAuthorizationSession } from "./deployment-authorization";
import type { PrivateDeploymentPrerequisiteResult } from "./prerequisites";

export interface PrivateDeploymentPrompt {
  readonly interactive: boolean;
  readonly question: (message: string) => Promise<string>;
  readonly write: (message: string) => void;
}

export interface PrivateDeploymentWizardArguments {
  readonly resume?: string;
  readonly createNew: boolean;
  readonly nonInteractive: boolean;
  readonly status: boolean;
  readonly abandon: boolean;
  readonly json: boolean;
  readonly noSaveAuthorization: boolean;
}

export interface PrivateDeploymentWizardDependencies {
  readonly prompt: PrivateDeploymentPrompt;
  readonly root?: string;
  readonly cliVersion?: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly staleLockMilliseconds?: number;
  readonly authorizeDeployment?: (
    state: PrivateDeploymentState,
    noSaveAuthorization: boolean,
  ) => Promise<PrivateDeploymentAuthorizationSession>;
  readonly runPrerequisites?: (
    state: PrivateDeploymentState,
    authorization: PrivateDeploymentAuthorizationSession,
  ) => Promise<PrivateDeploymentPrerequisiteResult>;
}

export interface PrivateDeploymentWizardResult {
  readonly action: "saved" | "authorization-required" | "authorized" | "prerequisites-ready" | "identity-ready" | "retention-ready" | "status" | "abandoned";
  readonly deployment: PrivateDeploymentState | null;
  readonly deployments?: readonly PrivateDeploymentState[];
  readonly resume_command?: string;
  readonly message: string;
  readonly authorization?: PrivateDeploymentAuthorizationSession;
}

type WizardControl = "back" | "save" | "cancel" | "abandon" | "new";

class WizardControlSignal extends Error {
  constructor(readonly control: WizardControl) {
    super(control);
  }
}

class RestartWizardSignal extends Error {}
class StartSeparateDeploymentSignal extends Error {}

const valueForFlag = (args: readonly string[], flag: string): string | undefined => {
  const indexes = args.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length > 1) throw new Error(`${flag} may be provided once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
};

const hasFlag = (args: readonly string[], flag: string): boolean => {
  const count = args.filter((value) => value === flag).length;
  if (count > 1) throw new Error(`${flag} may be provided once`);
  return count === 1;
};

export const parsePrivateDeploymentWizardArguments = (
  args: readonly string[],
): PrivateDeploymentWizardArguments => {
  const supportedFlags = new Set(["--resume", "--new", "--non-interactive", "--status", "--abandon", "--json", "--no-save-authorization"]);
  const unexpected = args.filter((argument, index) => {
    if (supportedFlags.has(argument)) return false;
    return index === 0 || args[index - 1] !== "--resume";
  });
  if (unexpected.length > 0) throw new Error(`Unknown private deployment option: ${unexpected[0]}`);
  const resume = valueForFlag(args, "--resume");
  const parsed: PrivateDeploymentWizardArguments = {
    ...(resume === undefined ? {} : { resume }),
    createNew: hasFlag(args, "--new"),
    nonInteractive: hasFlag(args, "--non-interactive"),
    status: hasFlag(args, "--status"),
    abandon: hasFlag(args, "--abandon"),
    json: hasFlag(args, "--json"),
    noSaveAuthorization: hasFlag(args, "--no-save-authorization"),
  };
  if (parsed.createNew && parsed.resume !== undefined) throw new Error("Choose --new or --resume, not both");
  if (parsed.abandon && parsed.resume === undefined) throw new Error("--abandon requires --resume <hostname-or-id>");
  if (parsed.status && (parsed.createNew || parsed.abandon)) {
    throw new Error("--status cannot be combined with --new or --abandon");
  }
  if (parsed.noSaveAuthorization && (parsed.status || parsed.abandon)) {
    throw new Error("--no-save-authorization is only valid while running deployment setup");
  }
  return parsed;
};

const normalizeControl = (answer: string): WizardControl | undefined => {
  const value = answer.trim().toLowerCase();
  if (value === "back" || value === "b") return "back";
  if (value === "save" || value === "save and exit" || value === "exit") return "save";
  if (value === "cancel" || value === "cancel current action") return "cancel";
  if (value === "abandon" || value === "abandon local deployment") return "abandon";
  if (value === "new" || value === "start a separate deployment") return "new";
  return undefined;
};

const askChoice = async (
  prompt: PrivateDeploymentPrompt,
  question: string,
  options: readonly string[],
): Promise<number> => {
  const menu = `${question}\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n> `;
  for (;;) {
    const answer = await prompt.question(menu);
    const control = normalizeControl(answer);
    if (control !== undefined) throw new WizardControlSignal(control);
    const selection = Number.parseInt(answer.trim(), 10);
    if (Number.isInteger(selection) && selection >= 1 && selection <= options.length) return selection - 1;
    prompt.write(`Enter a number from 1 to ${options.length}, or type Back, Save and exit, Abandon, or New.\n`);
  }
};

const resumeCommand = (state: PrivateDeploymentState): string =>
  `pnpm dlx artifactpass deploy --resume ${state.hostname ?? state.deployment_id}`;

const lastCheckpoint = (state: PrivateDeploymentState): string =>
  Object.entries(state.checkpoints)
    .sort(([, left], [, right]) => right.proven_at.localeCompare(left.proven_at))[0]?.[0] ?? "started";

const stateLabel = (state: PrivateDeploymentState): string => {
  const context = state.hostname ?? state.cloudflare?.zone_name ?? state.cloudflare?.account_name ?? state.deployment_id;
  return `${context} · ${lastCheckpoint(state)}`;
};

const saveResult = (state: PrivateDeploymentState, message: string): PrivateDeploymentWizardResult => ({
  action: "saved",
  deployment: state,
  resume_command: resumeCommand(state),
  message,
});

const selectDeployment = async (
  arguments_: PrivateDeploymentWizardArguments,
  dependencies: PrivateDeploymentWizardDependencies,
  root: string,
  cliVersion: string,
): Promise<PrivateDeploymentState> => {
  if (arguments_.resume !== undefined) {
    return resolvePrivateDeploymentState(root, arguments_.resume, cliVersion);
  }
  if (arguments_.createNew) {
    return createPrivateDeploymentState({
      root,
      cliVersion,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.createId === undefined ? {} : { createId: dependencies.createId }),
    });
  }
  const incomplete = (await listPrivateDeploymentStates(root, cliVersion))
    .filter((state) => state.status === "incomplete");
  if (incomplete.length === 0) {
    return createPrivateDeploymentState({
      root,
      cliVersion,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.createId === undefined ? {} : { createId: dependencies.createId }),
    });
  }
  if (!dependencies.prompt.interactive || arguments_.nonInteractive) {
    throw new Error("An incomplete private deployment already exists; use --resume <hostname-or-id> or --new");
  }
  if (incomplete.length === 1) {
    const selection = await askChoice(dependencies.prompt, `Resume ${stateLabel(incomplete[0] as PrivateDeploymentState)}?`, [
      "Resume this deployment",
      "Start a separate deployment",
    ]);
    if (selection === 0) return incomplete[0] as PrivateDeploymentState;
    return createPrivateDeploymentState({
      root,
      cliVersion,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.createId === undefined ? {} : { createId: dependencies.createId }),
    });
  }
  const selection = await askChoice(dependencies.prompt, "Which private deployment should ArtifactPass resume?", [
    ...incomplete.map(stateLabel),
    "Start a separate deployment",
  ]);
  if (selection < incomplete.length) return incomplete[selection] as PrivateDeploymentState;
  return createPrivateDeploymentState({
    root,
    cliVersion,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.createId === undefined ? {} : { createId: dependencies.createId }),
  });
};

const runInitialChoices = async (
  stateValue: PrivateDeploymentState,
  root: string,
  cliVersion: string,
  dependencies: PrivateDeploymentWizardDependencies,
): Promise<PrivateDeploymentWizardResult> => withPrivateDeploymentLock(
  root,
  stateValue.deployment_id,
  async () => {
    let state = await resolvePrivateDeploymentState(root, stateValue.deployment_id, cliVersion);
    const save = async (message: string): Promise<PrivateDeploymentWizardResult> => {
      state = await writePrivateDeploymentState(root, state, cliVersion, dependencies.now);
      return saveResult(state, message);
    };
    try {
      if (!dependencies.prompt.interactive || dependencies.prompt.question === undefined) {
        throw new Error("Private deployment setup needs an interactive terminal or explicit deployment flags");
      }
      dependencies.prompt.write(
        "Set up a private ArtifactPass deployment\n\n" +
        "ArtifactPass will deploy a Worker, D1 database, R2 bucket, and Cloudflare Access application into your Cloudflare account.\n" +
        "Cloudflare handles your account, plan, payment method, domain, and company login.\n\n",
      );
      if (state.checkpoints["setup-introduction-accepted"] === undefined) {
        const selection = await askChoice(dependencies.prompt, "Continue?", ["Yes", "Save and exit"]);
        if (selection === 1) return save("Private deployment setup was saved before Cloudflare authorization.");
        state = provePrivateDeploymentCheckpoint(
          state,
          "setup-introduction-accepted",
          { accepted: true },
          "started",
          (dependencies.now ?? (() => new Date()))(),
        );
        state = await writePrivateDeploymentState(root, state, cliVersion, dependencies.now);
      }
      if (state.registrar_authority_confirmed !== true) {
        const selection = await askChoice(
          dependencies.prompt,
          "Do you control the domain and have permission to update its registrar nameservers?",
          ["Yes", "Not yet"],
        );
        if (selection === 1) {
          return save("No Cloudflare changes were made. Resume after you have domain and registrar authority.");
        }
        state = provePrivateDeploymentCheckpoint(
          { ...state, registrar_authority_confirmed: true },
          "registrar-authority-confirmed",
          { confirmed: true },
          "started",
          (dependencies.now ?? (() => new Date()))(),
        );
        state = await writePrivateDeploymentState(root, state, cliVersion, dependencies.now);
      }
      if (state.sign_in_mode === undefined) {
        const selection = await askChoice(dependencies.prompt, "How should people sign in?", [
          "Email verification code",
          "Existing company login",
        ]);
        const signInMode: PrivateSignInMode = selection === 0 ? "email-code" : "company-login";
        state = provePrivateDeploymentCheckpoint(
          { ...state, sign_in_mode: signInMode },
          "sign-in-mode-selected",
          { mode: signInMode },
          "authorization-required",
          (dependencies.now ?? (() => new Date()))(),
        );
        state = await writePrivateDeploymentState(root, state, cliVersion, dependencies.now);
      }
      return {
        action: "authorization-required",
        deployment: state,
        resume_command: resumeCommand(state),
        message: "Setup choices are saved. ArtifactPass is ready to authorize the matching least-privilege Cloudflare profile.",
      };
    } catch (error) {
      if (!(error instanceof WizardControlSignal)) throw error;
      if (error.control === "abandon") {
        state = await writePrivateDeploymentState(root, { ...state, status: "abandoned" }, cliVersion, dependencies.now);
        return { action: "abandoned", deployment: state, message: "Local deployment progress was abandoned. Cloudflare resources were not deleted." };
      }
      if (error.control === "back") {
        const {
          sign_in_mode: _signInMode,
          registrar_authority_confirmed: _registrarAuthority,
          ...resetState
        } = state;
        state = invalidatePrivateDeploymentCheckpoints(
          resetState,
          ["registrar-authority-confirmed", "sign-in-mode-selected"],
          "started",
        );
        state = await writePrivateDeploymentState(root, state, cliVersion, dependencies.now);
        throw new RestartWizardSignal();
      }
      if (error.control === "new") {
        state = await writePrivateDeploymentState(root, state, cliVersion, dependencies.now);
        throw new StartSeparateDeploymentSignal();
      }
      return save(error.control === "cancel"
        ? "The current action was cancelled and proven progress was saved."
        : "Private deployment progress was saved.");
    }
  },
  dependencies.staleLockMilliseconds === undefined
    ? {}
    : { staleLockMilliseconds: dependencies.staleLockMilliseconds },
);

export const runPrivateDeploymentWizard = async (
  arguments_: PrivateDeploymentWizardArguments,
  dependencies: PrivateDeploymentWizardDependencies,
): Promise<PrivateDeploymentWizardResult> => {
  const cliVersion = dependencies.cliVersion ?? packageMetadata.version;
  const root = dependencies.root ?? privateDeploymentStateRoot();
  if (arguments_.status) {
    const deployments = arguments_.resume === undefined
      ? await listPrivateDeploymentStates(root, cliVersion)
      : [await resolvePrivateDeploymentState(root, arguments_.resume, cliVersion)];
    return {
      action: "status",
      deployment: deployments.length === 1 ? deployments[0] as PrivateDeploymentState : null,
      deployments,
      message: deployments.length === 0
        ? "No private ArtifactPass deployments are recorded on this machine."
        : `${deployments.length} private ArtifactPass deployment${deployments.length === 1 ? "" : "s"} recorded.`,
    };
  }
  if (arguments_.nonInteractive && arguments_.resume === undefined && !arguments_.createNew) {
    throw new Error("Non-interactive private deployment requires --resume <hostname-or-id>, --new, or the existing explicit deployment flags");
  }
  if (!arguments_.nonInteractive && !dependencies.prompt.interactive) {
    throw new Error("Private deployment setup needs an interactive terminal; use --status or the explicit deployment flags for automation");
  }
  const selected = await selectDeployment(arguments_, dependencies, root, cliVersion);
  if (arguments_.abandon) {
    const state = await withPrivateDeploymentLock(root, selected.deployment_id, async () =>
      writePrivateDeploymentState(root, { ...selected, status: "abandoned" }, cliVersion, dependencies.now));
    return {
      action: "abandoned",
      deployment: state,
      message: "Local deployment progress was abandoned. Cloudflare resources were not deleted.",
    };
  }
  if (arguments_.nonInteractive) {
    return saveResult(selected, "Private deployment state is available; interactive setup was not started.");
  }
  try {
    const result = await runInitialChoices(selected, root, cliVersion, dependencies);
    if (
      result.action !== "authorization-required" ||
      result.deployment === null ||
      dependencies.authorizeDeployment === undefined
    ) {
      return result;
    }
    const authorization = await dependencies.authorizeDeployment(
      result.deployment,
      arguments_.noSaveAuthorization,
    );
    if (!authorization.persisted) {
      if (dependencies.runPrerequisites !== undefined) {
        const prerequisiteResult = await dependencies.runPrerequisites(result.deployment, authorization);
        const persistedPrerequisiteState = await withPrivateDeploymentLock(
          root,
          result.deployment.deployment_id,
          async () => writePrivateDeploymentState(root, prerequisiteResult.state, cliVersion, dependencies.now),
        );
        return {
          action: prerequisiteResult.status === "ready"
            ? prerequisiteResult.state.stage === "retention-ready"
              ? "retention-ready"
              : prerequisiteResult.state.stage === "identity-ready" ? "identity-ready" : "prerequisites-ready"
            : "saved",
          deployment: persistedPrerequisiteState,
          resume_command: resumeCommand(persistedPrerequisiteState),
          message: `${prerequisiteResult.message} Cloudflare authorization was not saved and will be revoked when this command finishes.`,
          authorization,
        };
      }
      return {
        ...result,
        authorization,
        message: "Cloudflare is authorized for this process only. ArtifactPass will revoke it when this command finishes.",
      };
    }
    if (authorization.client === undefined) {
      throw new Error("Persisted Cloudflare OAuth authorization is missing its client binding");
    }
    const authorizedClient = authorization.client;
    const authorizedState = await withPrivateDeploymentLock(root, result.deployment.deployment_id, async () => {
      const current = await resolvePrivateDeploymentState(root, result.deployment?.deployment_id as string, cliVersion);
      const updated = provePrivateDeploymentCheckpoint(
        current,
        "cloudflare-authorized",
        {
          client_environment: authorizedClient.environment,
          profile: authorization.profile,
          granted_scopes: authorization.grantedScopes,
          persisted: true,
        },
        "cloudflare-authorized",
        (dependencies.now ?? (() => new Date()))(),
      );
      return writePrivateDeploymentState(root, updated, cliVersion, dependencies.now);
    });
    const authorizedResult: PrivateDeploymentWizardResult = {
      action: "authorized",
      deployment: authorizedState,
      resume_command: resumeCommand(authorizedState),
      message: "Cloudflare authorization is stored securely in your operating system credential store.",
      authorization,
    };
    if (dependencies.runPrerequisites === undefined) return authorizedResult;
    const prerequisiteResult = await dependencies.runPrerequisites(authorizedState, authorization);
    const persistedPrerequisiteState = await withPrivateDeploymentLock(
      root,
      authorizedState.deployment_id,
      async () => writePrivateDeploymentState(root, prerequisiteResult.state, cliVersion, dependencies.now),
    );
    return {
      action: prerequisiteResult.status === "ready"
        ? prerequisiteResult.state.stage === "retention-ready"
          ? "retention-ready"
          : prerequisiteResult.state.stage === "identity-ready" ? "identity-ready" : "prerequisites-ready"
        : "saved",
      deployment: persistedPrerequisiteState,
      resume_command: resumeCommand(persistedPrerequisiteState),
      message: prerequisiteResult.message,
      authorization,
    };
  } catch (error) {
    if (error instanceof RestartWizardSignal) {
      return runPrivateDeploymentWizard({
        resume: selected.deployment_id,
        createNew: false,
        nonInteractive: false,
        status: false,
        abandon: false,
        json: arguments_.json,
        noSaveAuthorization: arguments_.noSaveAuthorization,
      }, dependencies);
    }
    if (error instanceof StartSeparateDeploymentSignal) {
      return runPrivateDeploymentWizard({
        createNew: true,
        nonInteractive: false,
        status: false,
        abandon: false,
        json: arguments_.json,
        noSaveAuthorization: arguments_.noSaveAuthorization,
      }, dependencies);
    }
    throw error;
  }
};

export const renderPrivateDeploymentWizardResult = (result: PrivateDeploymentWizardResult): string => {
  const lines = [result.message];
  if (result.deployment !== null) {
    lines.push(`Deployment: ${result.deployment.hostname ?? result.deployment.deployment_id}`);
    lines.push(`Stage: ${result.deployment.stage}`);
  }
  if (result.deployments !== undefined && result.deployments.length > 1) {
    lines.push(...result.deployments.map((state) => `- ${stateLabel(state)} · ${state.status}`));
  }
  if (result.resume_command !== undefined) lines.push(`Resume: ${result.resume_command}`);
  return lines.join("\n");
};
