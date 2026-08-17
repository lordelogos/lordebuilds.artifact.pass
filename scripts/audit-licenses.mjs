import { execFileSync } from "node:child_process";

const allowedLicenses = new Set([
  "(MIT AND Zlib)",
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
]);

const report = JSON.parse(execFileSync(
  "pnpm",
  ["licenses", "list", "--prod", "--json"],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
));
const licenses = Object.keys(report);
const rejected = licenses.flatMap((license) => {
  if (allowedLicenses.has(license)) return [];
  if (
    license === "LGPL-3.0-or-later" &&
    report[license].every((dependency) => dependency.name.startsWith("@img/sharp-libvips-"))
  ) return [];
  return report[license].map((dependency) => `${dependency.name} (${license})`);
});
if (rejected.length > 0) {
  process.stderr.write(`Dependency license audit failed: ${rejected.join(", ")}\n`);
  process.exit(1);
}
const packageCount = Object.values(report).flat().length;
process.stdout.write(
  `Dependency license audit passed (${packageCount} package records; reviewed licenses: ${licenses.sort().join(", ")}).\n`,
);
