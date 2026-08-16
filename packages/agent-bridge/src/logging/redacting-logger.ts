const sensitiveKey = /(?:authorization|content|data|share_?url|token|secret|credential|password)/iu;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~-]+/giu;
const agentTokenPattern = /\bas_[A-Za-z0-9_-]{20,}\b/gu;
const cloudflareTokenPattern = /\bcfut_[A-Za-z0-9_-]{20,}\b/gu;
const shareUrlPattern = /https:\/\/[^\s/]+\/a\/[A-Za-z0-9_-]{32,256}(?:\/[^\s]*)?/gu;

export const redactSensitiveText = (value: string): string => value
  .replace(bearerPattern, "Bearer [REDACTED]")
  .replace(agentTokenPattern, "[REDACTED]")
  .replace(cloudflareTokenPattern, "[REDACTED]")
  .replace(shareUrlPattern, "[REDACTED SHARE URL]");

const redact = (value: unknown, key?: string): unknown => {
  if (key !== undefined && sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redact(nestedValue, nestedKey)]),
    );
  }
  return value;
};

export interface RedactingLogger {
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export const createRedactingLogger = (
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): RedactingLogger => ({
  error: (message, context = {}) => {
    write(JSON.stringify({
      level: "error",
      message: redactSensitiveText(message),
      context: redact(context),
    }));
  },
});
