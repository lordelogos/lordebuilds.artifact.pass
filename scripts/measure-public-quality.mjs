import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const targetUrl = process.env.PUBLIC_QUALITY_URL ?? "https://artifactpass.com/";
const chromePath = process.env.CHROME_PATH
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workspace = await mkdtemp(join(tmpdir(), "artifactpass-lighthouse-"));

const runLighthouse = async (name, extraArguments = []) => {
  const outputPath = join(workspace, `${name}.json`);
  await execFileAsync(
    "pnpm",
    [
      "dlx",
      "lighthouse@13.5.0",
      targetUrl,
      "--output=json",
      `--output-path=${outputPath}`,
      `--chrome-path=${chromePath}`,
      "--chrome-flags=--headless=new --no-sandbox",
      "--quiet",
      "--enable-error-reporting=false",
      ...extraArguments,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(await readFile(outputPath, "utf8"));
};

const auditScore = (report, auditId) => Number(report.audits[auditId]?.score ?? 0);
const categoryScore = (report, categoryId) => Number(report.categories[categoryId]?.score ?? 0);

try {
  const homepageResponse = await fetch(targetUrl, { redirect: "follow" });
  const [mobile, desktop] = await Promise.all([
    runLighthouse("mobile"),
    runLighthouse("desktop", ["--preset=desktop"]),
  ]);

  const minimumCategoryScore = (categoryId) => Math.min(
    categoryScore(mobile, categoryId),
    categoryScore(desktop, categoryId),
  );
  const minimumAuditScore = (auditId) => Math.min(
    auditScore(mobile, auditId),
    auditScore(desktop, auditId),
  );

  const accessibilityScore = minimumCategoryScore("accessibility");
  const bestPracticesScore = minimumCategoryScore("best-practices");
  const agenticBrowsingScore = minimumCategoryScore("agentic-browsing");
  const performanceScore = minimumCategoryScore("performance");
  const seoScore = minimumCategoryScore("seo");
  const requiredChecks = [
    accessibilityScore >= 1,
    bestPracticesScore >= 1,
    agenticBrowsingScore >= 1,
    performanceScore >= 0.98,
    seoScore >= 1,
  ];

  process.stdout.write(`${JSON.stringify({
    lighthouse_completed: 1,
    homepage_status: homepageResponse.status,
    quality_checks_passed: requiredChecks.filter(Boolean).length,
    accessibility_score: accessibilityScore,
    best_practices_score: bestPracticesScore,
    agentic_browsing_score: agenticBrowsingScore,
    performance_score: performanceScore,
    seo_score: seoScore,
    mobile_accessibility_score: categoryScore(mobile, "accessibility"),
    desktop_accessibility_score: categoryScore(desktop, "accessibility"),
    mobile_best_practices_score: categoryScore(mobile, "best-practices"),
    desktop_best_practices_score: categoryScore(desktop, "best-practices"),
    mobile_agentic_browsing_score: categoryScore(mobile, "agentic-browsing"),
    desktop_agentic_browsing_score: categoryScore(desktop, "agentic-browsing"),
    color_contrast_score: minimumAuditScore("color-contrast"),
    console_errors_score: minimumAuditScore("errors-in-console"),
    inspector_issues_score: minimumAuditScore("inspector-issues"),
    llms_txt_score: minimumAuditScore("llms-txt"),
    ard_schema_score: minimumAuditScore("ard-schema"),
    hsts_score: minimumAuditScore("has-hsts"),
    trusted_types_score: minimumAuditScore("trusted-types-xss"),
  })}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
