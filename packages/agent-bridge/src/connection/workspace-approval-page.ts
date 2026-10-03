export interface WorkspaceApprovalPageOptions {
  readonly workspaceRoot: string;
  readonly proposedOrigin: string;
  readonly availableOrigins: readonly string[];
  readonly token: string;
  readonly state?: "review" | "saving" | "approved" | "cancelled" | "failed";
  readonly message?: string;
}

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

export const renderWorkspaceApprovalPage = (
  options: WorkspaceApprovalPageOptions,
): string => {
  const terminal = options.state === "approved" || options.state === "cancelled";
  const title = options.state === "approved"
    ? "Project approved"
    : options.state === "cancelled"
      ? "Approval cancelled"
      : options.state === "failed"
        ? "Approval could not be saved"
        : "Allow ArtifactPass to publish from this project?";
  const description = options.message ?? (options.state === "approved"
    ? "Return to your agent. ArtifactPass can continue the original request."
    : options.state === "cancelled"
      ? "No project access was granted. You can close this tab."
      : options.state === "failed"
        ? "Nothing changed. Review the folder and destination, then try saving again."
        : "Review the exact folder and publishing destination before allowing access.");
  const originOptions = [...new Set([options.proposedOrigin, ...options.availableOrigins])]
    .map((origin) => `<option value="${escapeHtml(origin)}"></option>`)
    .join("");
  const form = terminal ? "" : `
    <form method="post" action="/workspace-approval">
      <input type="hidden" name="token" value="${escapeHtml(options.token)}">
      <label for="origin">Publish to</label>
      <input id="origin" name="origin" type="url" value="${escapeHtml(options.proposedOrigin)}" list="origins" required autocomplete="off" spellcheck="false">
      <datalist id="origins">${originOptions}</datalist>
      <p class="scope">This allows publishing supported files in this folder and its subfolders. ArtifactPass will still check every file before upload.</p>
      <div class="actions">
        <button type="submit" name="action" value="approve">Allow project</button>
        <button class="secondary" type="submit" name="action" value="cancel">Cancel</button>
      </div>
    </form>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ArtifactPass</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f2;color:#171817}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(100%,620px);background:#fff;border:1px solid #d9dad5;border-radius:18px;padding:32px;box-shadow:0 18px 60px rgba(0,0,0,.08)}.brand{font-weight:700;margin-bottom:28px}h1{font-size:clamp(1.65rem,5vw,2.3rem);line-height:1.08;margin:0 0 12px}p{color:#60635e;line-height:1.55}.details{margin:26px 0}.details strong,label{display:block;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:#70736d;margin-bottom:8px}.path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;padding:14px;background:#f3f4f1;border-radius:10px;margin:0 0 22px;color:#292b28}input{width:100%;min-height:48px;border:1px solid #c8cac4;border-radius:10px;padding:0 13px;background:transparent;color:inherit;font:inherit}.scope{font-size:.92rem;margin:16px 0 24px}.actions{display:flex;gap:10px;flex-wrap:wrap}button{min-height:48px;border:1px solid #171817;border-radius:10px;padding:0 18px;background:#171817;color:#fff;font:600 1rem inherit;cursor:pointer}.secondary{background:transparent;color:#171817}@media(max-width:520px){.card{padding:24px}.actions{display:grid}button{width:100%}}@media(prefers-color-scheme:dark){:root{background:#0d0f0e;color:#f4f5f2}.card{background:#151715;border-color:#30332f}.path{background:#20231f;color:#f4f5f2}p,.details strong,label{color:#aeb2aa}input{border-color:#454943}.secondary{color:#f4f5f2;border-color:#777c73}}
</style></head><body><main class="card"><div class="brand">ArtifactPass</div><h1>${escapeHtml(title)}</h1><p role="status">${escapeHtml(description)}</p><div class="details"><strong>Folder</strong><p class="path">${escapeHtml(options.workspaceRoot)}</p></div>${form}</main></body></html>`;
};

export const workspaceApprovalPageHeaders = (): Readonly<Record<string, string>> => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
});
