import { findSensitiveContent, findSensitivePath } from "./security-patterns.mjs";

export const auditSurfaceText = (records) => {
  const findings = [];
  for (const record of records) {
    const text = record.text ?? "";
    for (const match of findSensitiveContent(text)) {
      findings.push({
        surface: record.surface,
        identity: String(record.identity),
        label: match.label,
        line: text.slice(0, match.index).split("\n").length,
      });
    }
  }
  return findings;
};

export const auditSurfacePaths = (records) => records.flatMap((record) => {
  const sensitiveSegment = findSensitivePath(record.path ?? "");
  return sensitiveSegment
    ? [{
        surface: record.surface,
        identity: String(record.identity),
        label: "secret-bearing path",
        path_segment: sensitiveSegment,
      }]
    : [];
});
