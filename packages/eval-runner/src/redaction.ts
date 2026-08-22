import { randomUUID } from "node:crypto";

const REDACTED = "[REDACTED]";
const PATH_REDACTED = "[PATH]";
const SENSITIVE_KEY = /(?:authorization|cookie|credential|secret|token|api[-_]?key|raw[-_]?output|stderr|stdout)/iu;
const PATH_KEY = /(?:^|_)(?:path|directory|cwd|home|root)(?:$|_)/iu;
const BEARER_HEADER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const PLAIN_CAPABILITY_URL = /https?:\/\/[^\s"'<>\\]+\/a\/[A-Za-z0-9_-]{16,}/giu;
const ESCAPED_CAPABILITY_URL = /https?:\\?\/\\?\/[^\s"'<>]+?\\?\/a\\?\/[A-Za-z0-9_-]{16,}/giu;
const ENCODED_CAPABILITY_URL = /https?%3A%2F%2F[^\s"'<>]+?%2Fa%2F[A-Za-z0-9_-]{16,}/giu;
const LOCAL_ABSOLUTE_PATH = /(?:\/(?:Users|tmp|private\/(?:tmp|var))\/[^\s"'<>:,}]+|[A-Za-z]:\\[^\s"'<>:,}]+)/gu;
const BASE64_CANDIDATE = /\b[A-Za-z0-9+/_-]{24,}\b={0,2}/gu;
const CAPABILITY_URL_IN_TEXT = /https?:\/\/[^\s"'<>\\]+\/a\/[A-Za-z0-9_-]{16,}/u;

const decodedCandidates = (value: string): readonly string[] => {
  const candidates = [value, value.replaceAll("\\/", "/")];
  try {
    candidates.push(decodeURIComponent(value));
  } catch {
    // Invalid percent sequences are left to the literal patterns.
  }
  return candidates;
};

const bearerTokens = (value: string): ReadonlySet<string> => {
  const tokens = new Set<string>();
  for (const candidate of decodedCandidates(value)) {
    for (const match of candidate.matchAll(/\/a\/([A-Za-z0-9_-]{16,})/gu)) {
      if (match[1] !== undefined) tokens.add(match[1]);
    }
  }
  return tokens;
};

const encodedCapabilities = (value: string): ReadonlySet<string> => {
  const encoded = new Set<string>();
  for (const match of value.matchAll(BASE64_CANDIDATE)) {
    const candidate = match[0];
    if (candidate.length > 4_096) continue;
    try {
      const normalized = candidate.replaceAll("-", "+").replaceAll("_", "/");
      const decoded = Buffer.from(normalized, "base64").toString("utf8");
      if (CAPABILITY_URL_IN_TEXT.test(decoded)) encoded.add(candidate);
    } catch {
      // Invalid base64-like values are ordinary report text.
    }
  }
  return encoded;
};

export const redactSensitiveText = (value: string): string => {
  let redacted = value
    .replace(PLAIN_CAPABILITY_URL, REDACTED)
    .replace(ESCAPED_CAPABILITY_URL, REDACTED)
    .replace(ENCODED_CAPABILITY_URL, REDACTED)
    .replace(BEARER_HEADER, REDACTED)
    .replace(LOCAL_ABSOLUTE_PATH, PATH_REDACTED);
  for (const token of bearerTokens(value)) {
    redacted = redacted.replaceAll(token, REDACTED);
    redacted = redacted.replaceAll(encodeURIComponent(token), REDACTED);
  }
  for (const encoded of encodedCapabilities(value)) redacted = redacted.replaceAll(encoded, REDACTED);
  return redacted;
};

export const redactSensitiveValue = (value: unknown, key = ""): unknown => {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (PATH_KEY.test(key) && typeof value === "string") return PATH_REDACTED;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    redactSensitiveValue(childValue, childKey),
  ]));
};

export const serializeRedacted = (value: unknown): string =>
  redactSensitiveText(JSON.stringify(redactSensitiveValue(value)));

export const createIndependentRunId = (): string => randomUUID();

export class RedactingChunkCollector {
  readonly #chunks: string[] = [];

  push(chunk: string): void {
    this.#chunks.push(chunk);
  }

  finish(): string {
    return redactSensitiveText(this.#chunks.join(""));
  }
}
