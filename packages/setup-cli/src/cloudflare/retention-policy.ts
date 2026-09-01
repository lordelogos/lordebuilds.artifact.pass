import { PROTOCOL_MAX_EXPIRY_SECONDS } from "artifact-protocol";

export const storageLifecycleForMaximumExpiry = (maximumExpirySeconds: number): {
  readonly rules: readonly unknown[];
} => {
  if (!Number.isInteger(maximumExpirySeconds) || maximumExpirySeconds <= 0 || maximumExpirySeconds > PROTOCOL_MAX_EXPIRY_SECONDS) {
    throw new Error("Private maximum expiry is invalid");
  }
  const lifecycleSeconds = Math.ceil((maximumExpirySeconds + 24 * 60 * 60) / (24 * 60 * 60)) * 24 * 60 * 60;
  return {
    rules: [{
      id: "artifactpass-managed-retention",
      enabled: true,
      conditions: { prefix: "artifacts/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: lifecycleSeconds } },
    }],
  };
};
