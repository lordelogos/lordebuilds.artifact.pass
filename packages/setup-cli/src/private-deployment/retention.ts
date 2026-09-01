import { PROTOCOL_MAX_EXPIRY_SECONDS } from "artifact-protocol";

import { storageLifecycleForMaximumExpiry } from "../cloudflare/retention-policy";

export { storageLifecycleForMaximumExpiry } from "../cloudflare/retention-policy";

import type { BrowserHandoffPrompt } from "./browser-handoff";
import { provePrivateDeploymentCheckpoint, type PrivateDeploymentState } from "./deployment-state";

export const PRIVATE_RETENTION_PRESETS = Object.freeze([
  { seconds: 900, label: "15 minutes" },
  { seconds: 1800, label: "30 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: 604_800, label: "7 days" },
]);

export const validatePrivateRetentionPresets = (values: readonly number[]): readonly number[] => {
  const supported = new Set(PRIVATE_RETENTION_PRESETS.map(({ seconds }) => seconds));
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((value) => !Number.isInteger(value) || !supported.has(value) || value > PROTOCOL_MAX_EXPIRY_SECONDS) ||
    values.some((value, index) => index > 0 && value <= (values[index - 1] ?? 0))
  ) {
    throw new Error("Private expiry presets must be a non-empty, unique, increasing selection of the supported values");
  }
  return [...values];
};

export interface PrivateRetentionSetupResult {
  readonly state: PrivateDeploymentState;
  readonly maximumExpirySeconds: number;
  readonly lifecycle: ReturnType<typeof storageLifecycleForMaximumExpiry>;
}

export const runPrivateRetentionSetup = async (
  state: PrivateDeploymentState,
  prompt: BrowserHandoffPrompt,
  now: () => Date = () => new Date(),
): Promise<PrivateRetentionSetupResult> => {
  const existing = state.retention_seconds;
  let selection: readonly number[];
  if (existing !== undefined) {
    selection = validatePrivateRetentionPresets(existing);
  } else {
    for (;;) {
      const answer = await prompt.question([
        "Which link lifetimes should this private deployment offer?",
        ...PRIVATE_RETENTION_PRESETS.map((preset, index) => `${index + 1}. ${preset.label}`),
        "Enter one or more numbers separated by commas:",
        "> ",
      ].join("\n"));
      const indexes = [...new Set(answer.split(",").map((value) => Number.parseInt(value.trim(), 10) - 1))].sort((left, right) => left - right);
      if (indexes.length > 0 && indexes.every((index) => PRIVATE_RETENTION_PRESETS[index] !== undefined)) {
        selection = validatePrivateRetentionPresets(indexes.map((index) => PRIVATE_RETENTION_PRESETS[index]?.seconds as number));
        break;
      }
      prompt.write(`Choose one or more numbers from 1 to ${PRIVATE_RETENTION_PRESETS.length}.\n`);
    }
  }
  const maximumExpirySeconds = selection.at(-1) as number;
  const lifecycle = storageLifecycleForMaximumExpiry(maximumExpirySeconds);
  const updated = provePrivateDeploymentCheckpoint(
    { ...state, retention_seconds: selection },
    "retention-ready",
    {
      allowed_expiry_seconds: selection,
      maximum_expiry_seconds: maximumExpirySeconds,
      lifecycle,
    },
    "retention-ready",
    now(),
  );
  return { state: updated, maximumExpirySeconds, lifecycle };
};
