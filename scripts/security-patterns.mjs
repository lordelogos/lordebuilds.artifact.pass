const tokenPrefixes = ["cf" + "ut_", "as" + "_"];
const sharePath = "\\/" + "a\\/";

export const contentPatterns = [
  {
    label: "Cloudflare user token",
    pattern: new RegExp(`\\b${tokenPrefixes[0]}[A-Za-z0-9_-]{20,}\\b`, "gu"),
  },
  {
    label: "Artifact Share agent token",
    pattern: new RegExp(`\\b${tokenPrefixes[1]}[A-Za-z0-9_-]{32,}\\b`, "gu"),
  },
  {
    label: "Artifact Share capability URL",
    pattern: new RegExp(`https:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?${sharePath}[A-Za-z0-9_-]{32,256}`, "gu"),
  },
  {
    label: "private key",
    pattern: new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE ${"KEY"}-----`, "gu"),
  },
];

const sensitivePathSegments = [
  /^\.env(?:\.(?!example(?:\.|$))[^/]+)?$/iu,
  /^\.ssh$/iu,
  /^\.aws$/iu,
  /^\.gnupg$/iu,
  /^(?:id_rsa|id_ed25519|credentials|secrets?)$/iu,
];

export const findSensitiveContent = (source) => {
  const findings = [];
  for (const { label, pattern } of contentPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      findings.push({ label, index: match.index ?? 0 });
    }
  }
  return findings;
};

export const findSensitivePath = (path) => {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.find((segment) =>
    sensitivePathSegments.some((pattern) => pattern.test(segment))
  ) ?? null;
};
