import type { ArtifactManifest } from "artifact-protocol";
import { renderToStaticMarkup } from "react-dom/server";

import { HtmlViewer } from "../viewers/html-viewer";
import { MarkdownViewer } from "../viewers/markdown-viewer";
import { PdfViewer } from "../viewers/pdf-viewer";

export type ShareRepresentation =
  | { readonly kind: "markdown"; readonly html: string }
  | { readonly kind: "html"; readonly source: string }
  | { readonly kind: "pdf"; readonly sourceUrl: string };

export interface SharePageOptions {
  readonly manifest: ArtifactManifest;
  readonly nonce: string;
  readonly representation: ShareRepresentation;
  readonly sharePath: string;
}

const pageStyles = `
:root{color:#24241f;background:#f7f5ef;font-family:"Avenir Next",Avenir,"Helvetica Neue",Helvetica,sans-serif;color-scheme:light}
*{box-sizing:border-box}body{margin:0;min-width:320px;min-height:100vh}a{color:inherit}a:focus-visible{outline:3px solid #1f6c9f;outline-offset:3px}
.shell{width:min(1120px,100%);margin:0 auto;padding:24px clamp(18px,5vw,64px) 72px}.mast{display:flex;justify-content:space-between;gap:20px;padding-bottom:20px;border-bottom:1px solid #d8d5ca}.brand{font:700 1.08rem Georgia,serif;text-decoration:none}.meta{color:#706f67;font-size:.7rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.heading{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:end;padding:52px 0 28px}.heading h1{max-width:780px;margin:0;overflow-wrap:anywhere;font:400 clamp(2.6rem,6vw,5.6rem)/.96 Georgia,serif;letter-spacing:-.05em}.facts{display:grid;gap:6px;text-align:right;color:#706f67;font-size:.75rem;line-height:1.5}.viewer{min-height:54vh;background:#fffefa;border:1px solid #d8d5ca;border-radius:8px;overflow:hidden}.artifact-prose{max-width:760px;margin:0 auto;padding:clamp(28px,6vw,72px);font:17px/1.72 Georgia,serif}.artifact-prose h1,.artifact-prose h2,.artifact-prose h3{line-height:1.15;letter-spacing:-.025em}.artifact-prose pre{padding:18px;overflow:auto;background:#f1efe8;border:1px solid #d8d5ca;border-radius:4px}.artifact-prose code{font-family:"SFMono-Regular",Consolas,monospace;font-size:.86em}.artifact-prose table{width:100%;border-collapse:collapse}.artifact-prose th,.artifact-prose td{padding:9px;border:1px solid #d8d5ca;text-align:left}
.artifact-frame{display:block;width:100%;height:70vh;border:0;background:#fffefa}.footer{display:flex;justify-content:space-between;gap:24px;align-items:start;padding-top:22px;color:#706f67;font-size:.76rem;line-height:1.5}.download{padding-bottom:2px;color:#24241f;font-weight:700;text-decoration:none;border-bottom:1px solid #8d8a81}.expired{max-width:540px;margin:18vh auto 0;padding:36px;background:#fffefa;border:1px solid #d8d5ca;border-radius:8px}.expired h1{margin:0 0 12px;font:400 3rem/1 Georgia,serif;letter-spacing:-.04em}.expired p{margin:0;color:#706f67;line-height:1.6}
@media(max-width:680px){.meta{display:none}.heading{grid-template-columns:1fr}.facts{text-align:left}.footer{display:grid}.artifact-frame{height:62vh}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatType = (mimeType: ArtifactManifest["mime_type"]): string => ({
  "application/pdf": "PDF",
  "text/html": "HTML",
  "text/markdown": "Markdown",
})[mimeType];

const expiryScript = `(()=>{const root=document.querySelector("[data-expires-at]");if(!root)return;const expire=()=>{document.title="Artifact expired";document.body.innerHTML='<main class="expired"><h1>Artifact expired</h1><p>This temporary link has reached its cutoff. There is no history or recovery screen.</p></main>'};const remaining=Date.parse(root.dataset.expiresAt||"")-Date.now();if(!Number.isFinite(remaining)||remaining<=0){expire();return}setTimeout(expire,remaining)})();`;

export const renderSharePage = ({
  manifest,
  nonce,
  representation,
  sharePath,
}: SharePageOptions): string => {
  const extractionCopy = manifest.mime_type === "application/pdf"
    ? manifest.pdf_trust.status === "controlled"
      ? "Verified for agent reading"
      : "Human-only · unverified for agents"
    : "Exact uploaded source";
  const markup = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title>{`${manifest.filename} · ArtifactPass`}</title>
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: pageStyles }} />
      </head>
      <body data-expires-at={manifest.expires_at}>
        <main className="shell">
          <header className="mast">
            <span className="brand">ArtifactPass</span>
            <span className="meta">Temporary bearer link</span>
          </header>
          <section className="heading" aria-labelledby="artifact-title">
            <h1 id="artifact-title">{manifest.filename}</h1>
            <div className="facts">
              <span>{formatType(manifest.mime_type)} · {formatBytes(manifest.byte_size)}</span>
              <span>{extractionCopy}</span>
            </div>
          </section>
          <section className="viewer" aria-label={`${formatType(manifest.mime_type)} viewer`}>
            {representation.kind === "markdown" && <MarkdownViewer html={representation.html} />}
            {representation.kind === "html" && <HtmlViewer source={representation.source} />}
            {representation.kind === "pdf" && <PdfViewer sourceUrl={representation.sourceUrl} />}
          </section>
          <footer className="footer">
            <span>Available until {new Date(manifest.expires_at).toUTCString()}. This page closes at the cutoff.</span>
            <a className="download" href={`${sharePath}/raw`} download={manifest.filename}>Download exact file</a>
          </footer>
        </main>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: expiryScript }} />
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
};
