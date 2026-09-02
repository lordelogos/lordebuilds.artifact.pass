import type { ArtifactManifest } from "artifact-protocol";
import { renderToStaticMarkup } from "react-dom/server";

import { PublicNavigation } from "../components/public-chrome";
import { HtmlViewer } from "../viewers/html-viewer";
import { MarkdownViewer } from "../viewers/markdown-viewer";
import { PdfViewer } from "../viewers/pdf-viewer";
import { homepageBootScript, themeInteractionScript } from "./public-homepage";

export type ShareRepresentation =
  | { readonly kind: "markdown"; readonly html: string; readonly source: string }
  | { readonly kind: "html"; readonly previewUrl: string; readonly source: string }
  | { readonly kind: "pdf"; readonly sourceUrl: string };

export interface SharePageOptions {
  readonly manifest: ArtifactManifest;
  readonly nonce: string;
  readonly representation: ShareRepresentation;
  readonly sharePath: string;
}

const pageStyles = `
:root{--void:#0b0c0e;--graphite:#121418;--panel:rgba(255,255,255,.055);--panel-strong:rgba(255,255,255,.085);--line:rgba(255,255,255,.13);--line-strong:rgba(255,255,255,.22);--bone:#efefec;--ash:#b8babd;--slate:#797d82;--ink:#17181a;--white:#f9f9f7;--amber:#b98458;--violet:#716de4;--blue:#557fbd;--viewer-bg:#101216;--prose-bg:#14161a;--code-bg:#0b0c0e;--sans:"Avenir Next",Avenir,"Helvetica Neue",Helvetica,sans-serif;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;color-scheme:dark}
:root[data-theme="light"]{--void:#f3f3f0;--graphite:#fafaf8;--panel:rgba(23,24,26,.045);--panel-strong:rgba(23,24,26,.075);--line:rgba(23,24,26,.13);--line-strong:rgba(23,24,26,.23);--bone:#1b1c1e;--ash:#4f5358;--slate:#696e74;--ink:#f8f8f5;--white:#111214;--viewer-bg:#fdfdfb;--prose-bg:#fff;--code-bg:#f1f1ed;color-scheme:light}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{min-width:320px;min-height:100dvh;margin:0;color:var(--bone);background:var(--void);font-family:var(--sans);-webkit-font-smoothing:antialiased}button,a{font:inherit}a{color:inherit}.shell{width:min(1240px,calc(100% - 40px));margin:0 auto}.site-header{display:flex;align-items:center;justify-content:space-between;height:76px;border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;width:max-content;color:var(--bone);font-size:15px;font-weight:600;letter-spacing:-.03em;text-decoration:none}.brand-mark{display:block;width:20px;height:20px;margin-right:9px;color:var(--bone);flex:none}.header-actions{display:flex;align-items:center}.header-divider{width:1px;height:16px;margin:0 10px;background:var(--line)}.theme-toggle{display:grid;width:32px;height:32px;padding:0;border:0;color:var(--ash);background:transparent;cursor:pointer;place-items:center}.theme-toggle:hover{color:var(--bone);background:var(--panel)}.theme-symbol{display:block;width:18px;height:18px}.header-action{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:32px;padding:0 3px;border:0;color:var(--ash);background:transparent;text-decoration:none;font-size:12px;font-weight:500}.header-action svg{display:block;width:16px;height:16px}.header-action:hover{color:var(--bone);background:var(--panel)}.header-action--primary{min-height:31px;padding:0 12px;border:1px solid var(--white);border-radius:8px;color:var(--ink);background:var(--white);font-size:13px}.header-action--primary:hover{color:var(--ink);background:var(--white);opacity:.88}.theme-toggle:focus-visible,.header-action:focus-visible,.download:focus-visible{outline:2px solid var(--white);outline-offset:3px}
.viewer-main{padding:18px 0 24px}.viewer-shell{min-height:calc(100dvh - 118px);overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--viewer-bg)}.viewer-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;min-height:58px;padding:11px 13px 11px 18px;border-bottom:1px solid var(--line)}.viewer-identity{min-width:0}.viewer-filename{display:block;overflow:hidden;color:var(--bone);font-size:13px;font-weight:600;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.viewer-meta{display:block;margin-top:4px;overflow:hidden;color:var(--slate);font:500 10px/1.35 var(--mono);text-overflow:ellipsis;white-space:nowrap}.viewer-meta span+span:before{margin:0 7px;color:var(--line-strong);content:"·"}.viewer-actions{display:flex;align-items:center;gap:9px}.viewer-tabs{display:flex;align-items:center;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.viewer-tab{min-height:28px;padding:0 10px;border:0;border-radius:6px;color:var(--slate);background:transparent;cursor:pointer;font-size:11px}.viewer-tab[aria-selected="true"]{color:var(--bone);background:var(--panel-strong);box-shadow:0 0 0 1px var(--line)}.viewer-tab:hover{color:var(--bone)}.viewer-tab:focus-visible{outline:2px solid var(--white);outline-offset:2px}.download{display:inline-flex;align-items:center;min-height:34px;padding:0 12px;border:1px solid var(--line-strong);border-radius:8px;color:var(--bone);text-decoration:none;font-family:var(--sans);font-size:11px}.download:hover{border-color:var(--bone);background:var(--panel)}.viewer{min-height:calc(100dvh - 177px);background:var(--prose-bg);overflow:hidden}.viewer-panel[hidden]{display:none}.artifact-prose{max-width:840px;min-height:calc(100dvh - 177px);margin:0 auto;padding:clamp(32px,5vw,64px);color:var(--bone);font-size:17px;line-height:1.74}.artifact-prose>*:first-child{margin-top:0}.artifact-prose>*:last-child{margin-bottom:0}.artifact-prose h1,.artifact-prose h2,.artifact-prose h3{margin:1.7em 0 .6em;font-weight:600;line-height:1.15;letter-spacing:-.035em}.artifact-prose h1{font-size:2.4em}.artifact-prose h2{font-size:1.65em}.artifact-prose h3{font-size:1.2em}.artifact-prose p,.artifact-prose ul,.artifact-prose ol{color:var(--ash)}.artifact-prose a{overflow-wrap:anywhere;text-decoration-thickness:1px;text-underline-offset:3px}.artifact-prose pre{max-width:100%;padding:18px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--code-bg)}.artifact-prose code{font-family:var(--mono);font-size:.86em}.artifact-prose :not(pre)>code{padding:.16em .35em;border:1px solid var(--line);border-radius:5px;background:var(--code-bg)}.artifact-prose img{max-width:100%;height:auto}.artifact-prose table{display:block;width:100%;overflow-x:auto;border-collapse:collapse}.artifact-prose th,.artifact-prose td{min-width:120px;padding:10px;border:1px solid var(--line);text-align:left}.artifact-prose blockquote{margin-left:0;padding-left:18px;border-left:2px solid var(--line-strong);color:var(--ash)}.artifact-source{width:100%;min-height:calc(100dvh - 177px);margin:0;padding:clamp(24px,4vw,48px);overflow:auto;color:var(--ash);background:var(--code-bg);font:13px/1.7 var(--mono);tab-size:2;white-space:pre}.artifact-source code{font:inherit}.artifact-source--html{color:var(--bone)}
.artifact-frame{display:block;width:100%;height:calc(100dvh - 177px);border:0;background:#fff}.artifact-frame--pdf{background:#303236}.expired-shell{display:grid;min-height:100dvh;padding:24px;place-items:center}.expired{width:min(560px,100%);padding:34px;border:1px solid var(--line);border-radius:22px;background:var(--graphite);box-shadow:0 24px 70px rgba(0,0,0,.18)}.expired-label{display:flex;align-items:center;gap:9px;margin:0 0 18px;color:var(--ash);font:500 11px/1 var(--mono)}.expired-label:before{width:18px;height:1px;background:linear-gradient(90deg,var(--amber),var(--violet),var(--blue));content:""}.expired h1{margin:0;font-size:clamp(42px,8vw,58px);font-weight:500;line-height:1;letter-spacing:-.055em}.expired-copy{max-width:470px;margin:18px 0 0;color:var(--ash);font-size:15px;line-height:1.6}.expired-actions{display:flex;gap:10px;margin-top:28px}.expired-action{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;border:1px solid var(--line-strong);border-radius:9px;color:var(--bone);text-decoration:none;font-size:12px;font-weight:500}.expired-action:hover{border-color:var(--bone);background:var(--panel)}.expired-action--primary{border-color:var(--white);color:var(--ink);background:var(--white)}.expired-action--primary:hover{color:var(--ink);background:var(--white);opacity:.88}.expired-action:focus-visible{outline:2px solid var(--white);outline-offset:3px}.expired-note{margin:28px 0 0;padding-top:18px;border-top:1px solid var(--line);color:var(--slate);font:500 10px/1.55 var(--mono)}
@media(max-width:680px){.shell{width:calc(100% - 20px)}.site-header{height:64px}.header-divider{margin:0 7px}.header-action{width:32px;padding:0}.header-action--primary{width:32px;padding:0}.header-action-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}.viewer-main{padding:10px 0}.viewer-shell{min-height:calc(100dvh - 84px);border-radius:12px}.viewer-toolbar{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"filename download" "meta tabs";column-gap:12px;row-gap:7px;min-height:72px;padding:10px 10px 9px}.viewer-identity,.viewer-actions{display:contents}.viewer-filename{grid-area:filename;align-self:center}.viewer-meta{grid-area:meta;align-self:center;max-width:none;margin-top:0}.viewer-meta-source{display:none}.viewer-tabs{grid-area:tabs;justify-self:end}.download{grid-area:download;justify-self:end;width:34px;padding:0;font-size:0;justify-content:center}.download:after{font:500 17px/1 var(--sans);content:"↓"}.viewer,.artifact-prose,.artifact-source{min-height:calc(100dvh - 203px)}.artifact-prose{padding:28px 20px;font-size:16px}.artifact-source{padding:22px 18px;font-size:12px}.artifact-frame{height:calc(100dvh - 203px)}.expired-shell{padding:14px}.expired{padding:26px 22px;border-radius:18px}.expired-actions{flex-direction:column}.expired-action{width:100%}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition-duration:0s!important}}
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

const expiryScript = `(()=>{const root=document.querySelector("[data-expires-at]");const countdown=document.querySelector("[data-expiry-countdown]");if(!root)return;const expire=()=>{document.title="Artifact expired · ArtifactPass";document.body.innerHTML='<main class="expired-shell"><section class="expired"><p class="expired-label">Temporary artifact</p><h1>Artifact expired.</h1><p class="expired-copy">This temporary link reached its cutoff. The artifact is no longer available through ArtifactPass.</p><div class="expired-actions"><a class="expired-action expired-action--primary" href="/?upload=1">Share a document</a><a class="expired-action" href="/#install">Set up ArtifactPass</a></div><p class="expired-note">For privacy, expired artifacts have no history or recovery screen.</p></section></main>'};const cutoff=Date.parse(root.dataset.expiresAt||"");const formatRemaining=(remaining)=>{const minutes=Math.max(1,Math.ceil(remaining/60000));const compact=window.matchMedia("(max-width:680px)").matches;if(compact){if(minutes<120)return minutes+" min left";const hours=Math.ceil(minutes/60);if(hours<48)return hours+" hr left";return Math.ceil(hours/24)+" d left"}if(minutes<120)return minutes===1?"1 minute remaining":minutes+" minutes remaining";const hours=Math.ceil(minutes/60);if(hours<48)return hours===1?"1 hour remaining":hours+" hours remaining";const days=Math.ceil(hours/24);return days===1?"1 day remaining":days+" days remaining"};const update=()=>{const remaining=cutoff-Date.now();if(!Number.isFinite(remaining)||remaining<=0){expire();return false}if(countdown)countdown.textContent=formatRemaining(remaining);return true};if(!update())return;const timer=setInterval(()=>{if(!update())clearInterval(timer)},30000);setTimeout(expire,cutoff-Date.now())})();`;

const viewerModeScript = `(()=>{const tabs=[...document.querySelectorAll("[data-viewer-mode]")];if(tabs.length===0)return;const panels=[...document.querySelectorAll("[data-viewer-panel]")];const select=(mode)=>{for(const tab of tabs){const selected=tab.dataset.viewerMode===mode;tab.setAttribute("aria-selected",String(selected));tab.tabIndex=selected?0:-1}for(const panel of panels)panel.hidden=panel.dataset.viewerPanel!==mode};for(const tab of tabs){tab.addEventListener("click",()=>select(tab.dataset.viewerMode));tab.addEventListener("keydown",(event)=>{if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;event.preventDefault();const index=tabs.indexOf(tab);const next=event.key==="ArrowRight"?(index+1)%tabs.length:(index-1+tabs.length)%tabs.length;tabs[next].focus();select(tabs[next].dataset.viewerMode)})}})();`;

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
        <meta name="theme-color" content="#0b0c0e" />
        <link rel="icon" href="/artifactpass-logo.svg" type="image/svg+xml" />
        <title>{`${manifest.filename} · ArtifactPass`}</title>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: homepageBootScript }} />
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: pageStyles }} />
      </head>
      <body data-expires-at={manifest.expires_at}>
        <div className="shell">
          <PublicNavigation />
          <main className="viewer-main">
            <section className="viewer-shell" aria-labelledby="artifact-title">
              <div className="viewer-toolbar">
                <div className="viewer-identity">
                  <strong className="viewer-filename" id="artifact-title">{manifest.filename}</strong>
                  <span className="viewer-meta" aria-label="Artifact details">
                    <span>{formatType(manifest.mime_type)} · {formatBytes(manifest.byte_size)}</span>
                    <span className="viewer-meta-source">{extractionCopy}</span>
                    <span data-expiry-countdown>Temporary access</span>
                  </span>
                </div>
                <div className="viewer-actions">
                  {representation.kind === "markdown" && (
                    <div className="viewer-tabs" role="tablist" aria-label="Markdown view">
                      <button className="viewer-tab" type="button" role="tab" aria-controls="viewer-panel-rendered" aria-selected="true" data-viewer-mode="rendered">Rendered</button>
                      <button className="viewer-tab" type="button" role="tab" aria-controls="viewer-panel-raw" aria-selected="false" data-viewer-mode="raw" tabIndex={-1}>Raw</button>
                    </div>
                  )}
                  {representation.kind === "html" && (
                    <div className="viewer-tabs" role="tablist" aria-label="HTML view">
                      <button className="viewer-tab" type="button" role="tab" aria-controls="viewer-panel-preview" aria-selected="true" data-viewer-mode="preview">Preview</button>
                      <button className="viewer-tab" type="button" role="tab" aria-controls="viewer-panel-source" aria-selected="false" data-viewer-mode="source" tabIndex={-1}>Source</button>
                    </div>
                  )}
                  <a className="download" href={`${sharePath}/raw`} download={manifest.filename}>Download exact file</a>
                </div>
              </div>
              <div className="viewer" aria-label={`${formatType(manifest.mime_type)} viewer`}>
                {representation.kind === "markdown" && <MarkdownViewer html={representation.html} source={representation.source} />}
                {representation.kind === "html" && <HtmlViewer previewUrl={representation.previewUrl} source={representation.source} />}
                {representation.kind === "pdf" && <PdfViewer sourceUrl={representation.sourceUrl} />}
              </div>
            </section>
          </main>
        </div>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInteractionScript }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: viewerModeScript }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: expiryScript }} />
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
};
