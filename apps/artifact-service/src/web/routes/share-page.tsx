import type { ArtifactManifest } from "artifact-protocol";
import { renderToStaticMarkup } from "react-dom/server";

import { ArtifactPassIcon, ThemeIcon } from "../components/brand-icons";
import { HtmlViewer } from "../viewers/html-viewer";
import { MarkdownViewer } from "../viewers/markdown-viewer";
import { PdfViewer } from "../viewers/pdf-viewer";
import { homepageBootScript, themeInteractionScript } from "./public-homepage";
import { publicSiteUrl } from "../public-site";

export type ShareRepresentation =
  | { readonly kind: "markdown"; readonly html: string; readonly source: string }
  | {
      readonly kind: "html";
      readonly interactiveUrl: string | undefined;
      readonly previewUrl: string;
      readonly source: string;
    }
  | { readonly kind: "pdf"; readonly sourceUrl: string };

export interface SharePageOptions {
  readonly manifest: ArtifactManifest;
  readonly nonce: string;
  readonly representation: ShareRepresentation;
  readonly sharePath: string;
}

const pageStyles = `
:root{--void:#0b0c0e;--graphite:#121418;--panel:rgba(255,255,255,.055);--panel-strong:rgba(255,255,255,.085);--line:rgba(255,255,255,.13);--line-strong:rgba(255,255,255,.22);--bone:#efefec;--ash:#b8babd;--slate:#797d82;--ink:#17181a;--white:#f9f9f7;--amber:#b98458;--violet:#716de4;--blue:#557fbd;--success:#75c69a;--viewer-bg:#101216;--prose-bg:#14161a;--code-bg:#0b0c0e;--sans:"Avenir Next",Avenir,"Helvetica Neue",Helvetica,sans-serif;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;color-scheme:dark}
:root[data-theme="light"]{--void:#f3f3f0;--graphite:#fafaf8;--panel:rgba(23,24,26,.045);--panel-strong:rgba(23,24,26,.075);--line:rgba(23,24,26,.13);--line-strong:rgba(23,24,26,.23);--bone:#1b1c1e;--ash:#4f5358;--slate:#696e74;--ink:#f8f8f5;--white:#111214;--success:#24714a;--viewer-bg:#fdfdfb;--prose-bg:#fff;--code-bg:#f1f1ed;color-scheme:light}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{min-width:320px;min-height:100dvh;margin:0;color:var(--bone);background:var(--void);font-family:var(--sans);-webkit-font-smoothing:antialiased}button,a{font:inherit}a{color:inherit}.shell{width:100%;margin:0}
.viewer-main{padding:0}.viewer-shell{min-height:100dvh;overflow:hidden;background:var(--viewer-bg)}.viewer-toolbar{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:14px;min-height:59px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--void)}.viewer-home{display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:0 5px;color:var(--bone);text-decoration:none;font-size:13px;font-weight:600;letter-spacing:-.03em}.viewer-home:hover{opacity:.75}.viewer-home-mark{display:block;width:19px;height:19px;flex:none}.viewer-identity{min-width:0;padding-left:14px;border-left:1px solid var(--line)}.viewer-filename{display:block;overflow:hidden;color:var(--bone);font-size:13px;font-weight:600;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.viewer-meta{display:block;margin-top:3px;overflow:hidden;color:var(--slate);font:500 9px/1.35 var(--mono);text-overflow:ellipsis;white-space:nowrap}.viewer-meta span+span:before{margin:0 7px;color:var(--line-strong);content:"·"}.viewer-actions{display:flex;align-items:center;gap:8px}.viewer-tabs{display:flex;align-items:center;height:34px;overflow:hidden;border:1px solid var(--line-strong);border-radius:8px;background:transparent}.viewer-tab{height:32px;padding:0 10px;border:0;border-radius:0;color:var(--slate);background:transparent;cursor:pointer;font-size:11px}.viewer-tab+.viewer-tab{border-left:1px solid var(--line)}.viewer-tab[aria-selected="true"]{color:var(--bone);background:var(--panel-strong)}.viewer-tab:hover{color:var(--bone);background:var(--panel)}.viewer-tab:focus-visible{outline:2px solid var(--white);outline-offset:-3px}.viewer-theme,.download{display:inline-flex;align-items:center;justify-content:center;height:34px;border:1px solid var(--line-strong);border-radius:8px;color:var(--bone);background:transparent}.viewer-theme{width:34px;padding:0;cursor:pointer}.viewer-theme-icon{display:block;width:16px;height:16px}.download{padding:0 12px;text-decoration:none;font-family:var(--sans);font-size:11px}.viewer-theme:hover,.download:hover{border-color:var(--bone);background:var(--panel)}.viewer-home:focus-visible,.viewer-theme:focus-visible,.download:focus-visible{outline:2px solid var(--white);outline-offset:3px}.viewer{min-height:calc(100dvh - 59px);background:var(--prose-bg);overflow:hidden}.viewer-panel[hidden]{display:none}.artifact-prose{max-width:840px;min-height:calc(100dvh - 59px);margin:0 auto;padding:clamp(32px,5vw,64px);color:var(--bone);font-size:17px;line-height:1.74}.artifact-prose>*:first-child{margin-top:0}.artifact-prose>*:last-child{margin-bottom:0}.artifact-prose h1,.artifact-prose h2,.artifact-prose h3{margin:1.7em 0 .6em;font-weight:600;line-height:1.15;letter-spacing:-.035em}.artifact-prose h1{font-size:2.4em}.artifact-prose h2{font-size:1.65em}.artifact-prose h3{font-size:1.2em}.artifact-prose p,.artifact-prose ul,.artifact-prose ol{color:var(--ash)}.artifact-prose a{overflow-wrap:anywhere;text-decoration-thickness:1px;text-underline-offset:3px}.artifact-prose pre{max-width:100%;padding:18px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--code-bg)}.artifact-prose code{font-family:var(--mono);font-size:.86em}.artifact-prose :not(pre)>code{padding:.16em .35em;border:1px solid var(--line);border-radius:5px;background:var(--code-bg)}.artifact-prose img{max-width:100%;height:auto}.artifact-prose table{display:block;width:100%;overflow-x:auto;border-collapse:collapse}.artifact-prose th,.artifact-prose td{min-width:120px;padding:10px;border:1px solid var(--line);text-align:left}.artifact-prose blockquote{margin-left:0;padding-left:18px;border-left:2px solid var(--line-strong);color:var(--ash)}.artifact-source{width:100%;min-height:calc(100dvh - 59px);margin:0;padding:clamp(24px,4vw,48px);overflow:auto;color:var(--ash);background:var(--code-bg);font:13px/1.7 var(--mono);tab-size:2;white-space:pre}.artifact-source code{font:inherit}.artifact-source--html{color:var(--bone)}
.artifact-frame{display:block;width:100%;height:calc(100dvh - 59px);border:0;background:#fff}.artifact-frame--pdf{background:#303236}.html-preview{display:grid;height:calc(100dvh - 59px);grid-template-rows:auto minmax(0,1fr);overflow:hidden;background:#fff}.html-preview--static{grid-template-rows:minmax(0,1fr)}.interactive-banner{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:9px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--line);color:var(--bone);background:var(--graphite)}.interactive-symbol{display:grid;width:28px;height:28px;border:1px solid var(--line-strong);border-radius:7px;color:var(--slate);background:var(--panel);font:600 9px/1 var(--mono);letter-spacing:.04em;place-items:center}.interactive-copy{display:flex;align-items:baseline;min-width:0;gap:8px}.interactive-copy strong{display:block;font-size:11px;font-weight:600;white-space:nowrap}.interactive-copy>span{display:block;overflow:hidden;color:var(--slate);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.interactive-toggle{height:34px;padding:0 10px;border:1px solid var(--white);border-radius:7px;color:var(--ink);background:var(--white);cursor:pointer;font-size:10px;font-weight:600}.interactive-toggle-label--compact{display:none}.interactive-toggle:focus-visible{outline:2px solid var(--white);outline-offset:2px}.html-preview[data-interactive-active="true"] .interactive-symbol{border-color:var(--success);color:var(--success);background:color-mix(in srgb,var(--success) 8%,var(--graphite))}.html-preview[data-interactive-active="true"] .interactive-toggle{border-color:var(--line-strong);color:var(--bone);background:transparent}.html-preview-viewport{position:relative;width:100%;height:100%;overflow:hidden}.artifact-frame--html{height:100%;transform-origin:top left}.html-zoom-menu{position:absolute;z-index:2;top:12px;right:12px}.html-zoom-trigger,.html-zoom-controls{height:34px;border:1px solid var(--line-strong);border-radius:9px;color:var(--bone);background:color-mix(in srgb,var(--graphite) 92%,transparent);box-shadow:0 8px 28px rgba(0,0,0,.2);backdrop-filter:blur(12px)}.html-zoom-trigger{display:grid;width:34px;padding:0;cursor:pointer;place-items:center}.html-zoom-trigger:hover{background:var(--graphite)}.html-zoom-trigger:focus-visible{outline:2px solid var(--white);outline-offset:2px}.html-zoom-controls{position:absolute;top:0;right:42px;display:flex;align-items:center;padding:3px}.html-zoom-controls[hidden]{display:none}.html-zoom-button{display:grid;height:26px;min-width:28px;padding:0 7px;border:0;border-radius:6px;color:var(--ash);background:transparent;cursor:pointer;font:600 11px/1 var(--sans);place-items:center}.html-zoom-button:hover{color:var(--bone);background:var(--panel-strong)}.html-zoom-button:focus-visible{outline:2px solid var(--white);outline-offset:1px}.html-zoom-button[aria-pressed="true"]{color:var(--bone);background:var(--panel-strong)}.html-zoom-fit{min-width:38px}.html-zoom-step{font-size:16px;font-weight:400}.html-zoom-value{min-width:47px;font-family:var(--mono);font-size:10px}.html-zoom-divider{width:1px;height:16px;margin:0 2px;background:var(--line)}.expired-shell{display:grid;min-height:100dvh;padding:24px;place-items:center}.expired{width:min(560px,100%);padding:34px;border:1px solid var(--line);border-radius:22px;background:var(--graphite);box-shadow:0 24px 70px rgba(0,0,0,.18)}.expired-label{display:flex;align-items:center;gap:9px;margin:0 0 18px;color:var(--ash);font:500 11px/1 var(--mono)}.expired-label:before{width:18px;height:1px;background:linear-gradient(90deg,var(--amber),var(--violet),var(--blue));content:""}.expired h1{margin:0;font-size:clamp(42px,8vw,58px);font-weight:500;line-height:1;letter-spacing:-.055em}.expired-copy{max-width:470px;margin:18px 0 0;color:var(--ash);font-size:15px;line-height:1.6}.expired-actions{display:flex;gap:10px;margin-top:28px}.expired-action{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;border:1px solid var(--line-strong);border-radius:9px;color:var(--bone);text-decoration:none;font-size:12px;font-weight:500}.expired-action:hover{border-color:var(--bone);background:var(--panel)}.expired-action--primary{border-color:var(--white);color:var(--ink);background:var(--white)}.expired-action--primary:hover{color:var(--ink);background:var(--white);opacity:.88}.expired-action:focus-visible{outline:2px solid var(--white);outline-offset:3px}.expired-note{margin:28px 0 0;padding-top:18px;border-top:1px solid var(--line);color:var(--slate);font:500 10px/1.55 var(--mono)}
@media(max-width:680px){.viewer-toolbar{gap:7px;min-height:54px;padding:8px 9px}.viewer-home{width:32px;min-height:32px;padding:0;justify-content:center}.viewer-home-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}.viewer-home-mark{width:18px;height:18px}.viewer-identity{padding-left:8px}.viewer-filename{font-size:11px}.viewer-meta{display:none}.viewer-actions{gap:5px}.viewer-tabs{height:32px;border-radius:7px}.viewer-tab{height:30px;padding:0 7px;font-size:10px}.viewer-theme,.download{width:32px;height:32px;padding:0}.viewer-theme-icon{width:15px;height:15px}.download{font-size:0}.download:after{font:500 16px/1 var(--sans);content:"↓"}.viewer,.artifact-prose,.artifact-source{min-height:calc(100dvh - 54px)}.artifact-prose{padding:28px 20px;font-size:16px}.artifact-source{padding:22px 18px;font-size:12px}.artifact-frame{height:calc(100dvh - 54px)}.html-preview{height:calc(100dvh - 54px)}.interactive-banner{gap:8px;padding:6px 9px}.interactive-copy>span{display:none}.interactive-copy strong{overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.interactive-toggle{height:32px;padding:0 8px}.interactive-toggle-label--full{display:none}.interactive-toggle-label--compact{display:inline}.html-zoom-menu{top:8px;right:8px}.expired-shell{padding:14px}.expired{padding:26px 22px;border-radius:18px}.expired-actions{flex-direction:column}.expired-action{width:100%}}
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

const expiryScript = `(()=>{const root=document.querySelector("[data-expires-at]");const countdown=document.querySelector("[data-expiry-countdown]");if(!root)return;const expire=()=>{document.title="Artifact expired · ArtifactPass";document.body.innerHTML='<main class="expired-shell"><section class="expired"><p class="expired-label">Temporary artifact</p><h1>Artifact expired.</h1><p class="expired-copy">This temporary link reached its cutoff. The artifact is no longer available through ArtifactPass.</p><div class="expired-actions"><a class="expired-action expired-action--primary" href="/upload">Share a document</a><a class="expired-action" href="${publicSiteUrl("/#install")}">Set up ArtifactPass</a></div><p class="expired-note">For privacy, expired artifacts have no history or recovery screen.</p></section></main>'};const cutoff=Date.parse(root.dataset.expiresAt||"");const formatRemaining=(remaining)=>{const minutes=Math.max(1,Math.ceil(remaining/60000));if(minutes<120)return{short:minutes+"m left",full:minutes===1?"1 minute remaining":minutes+" minutes remaining"};const hours=Math.ceil(minutes/60);if(hours<48)return{short:hours+"h left",full:hours===1?"1 hour remaining":hours+" hours remaining"};const days=Math.ceil(hours/24);return{short:days+"d left",full:days===1?"1 day remaining":days+" days remaining"}};const update=()=>{const remaining=cutoff-Date.now();if(!Number.isFinite(remaining)||remaining<=0){expire();return false}if(countdown){const formatted=formatRemaining(remaining);countdown.textContent=formatted.short;countdown.setAttribute("aria-label",formatted.full);countdown.title=formatted.full}return true};if(!update())return;const timer=setInterval(()=>{if(!update())clearInterval(timer)},30000);setTimeout(expire,cutoff-Date.now())})();`;

const viewerModeScript = `(()=>{const tabs=[...document.querySelectorAll("[data-viewer-mode]")];if(tabs.length===0)return;const panels=[...document.querySelectorAll("[data-viewer-panel]")];const select=(mode)=>{for(const tab of tabs){const selected=tab.dataset.viewerMode===mode;tab.setAttribute("aria-selected",String(selected));tab.tabIndex=selected?0:-1}for(const panel of panels)panel.hidden=panel.dataset.viewerPanel!==mode};for(const tab of tabs){tab.addEventListener("click",()=>select(tab.dataset.viewerMode));tab.addEventListener("keydown",(event)=>{if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;event.preventDefault();const index=tabs.indexOf(tab);const next=event.key==="ArrowRight"?(index+1)%tabs.length:(index-1+tabs.length)%tabs.length;tabs[next].focus();select(tabs[next].dataset.viewerMode)})}})();`;

const htmlZoomScript = `(()=>{const root=document.querySelector("[data-html-preview]");if(!root)return;const viewport=root.querySelector("[data-html-preview-viewport]");const menu=root.querySelector("[data-html-zoom-menu]");const trigger=root.querySelector("[data-html-zoom-trigger]");const controls=root.querySelector('[aria-label="HTML preview zoom"]');const fitButton=root.querySelector('[data-html-zoom="fit"]');const valueButton=root.querySelector('[data-html-zoom="reset"]');const levels=[.25,.5,.75,1,1.25,1.5,2];let mode=window.matchMedia("(max-width:680px)").matches?"fit":"fixed";let scale=1;const setOpen=(open)=>{controls.hidden=!open;trigger.setAttribute("aria-expanded",String(open));menu.dataset.open=String(open)};const fitScale=()=>Math.min(1,viewport.clientWidth/1280);const apply=()=>{const frame=root.querySelector(".artifact-frame--html");if(!frame)return;const next=mode==="fit"?fitScale():scale;frame.style.width=mode==="fit"&&next<1?"1280px":100/next+"%";frame.style.height=viewport.clientHeight/next+"px";frame.style.transform="scale("+next+")";fitButton.setAttribute("aria-pressed",String(mode==="fit"));valueButton.textContent=Math.round(next*100)+"%"};const nearestIndex=(direction)=>{const current=mode==="fit"?fitScale():scale;if(direction>0)return levels.findIndex(level=>level>current+.001);for(let index=levels.length-1;index>=0;index-=1)if(levels[index]<current-.001)return index;return-1};trigger.addEventListener("click",()=>setOpen(controls.hidden));document.addEventListener("click",event=>{if(!menu.contains(event.target))setOpen(false)});document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!controls.hidden){setOpen(false);trigger.focus()}});root.addEventListener("click",event=>{const button=event.target.closest("[data-html-zoom]");if(!button)return;const action=button.dataset.htmlZoom;if(action==="fit"){mode="fit"}else if(action==="reset"){mode="fixed";scale=1}else{const index=nearestIndex(action==="in"?1:-1);if(index<0)return;mode="fixed";scale=levels[index]}apply()});window.addEventListener("artifactpass:html-frame-replaced",apply);new ResizeObserver(apply).observe(viewport);apply()})();`;

const htmlInteractiveScript = `(()=>{const root=document.querySelector("[data-html-preview]");if(!root)return;const toggle=root.querySelector("[data-interactive-toggle]");if(!toggle)return;const fullLabel=root.querySelector("[data-interactive-toggle-full]");const compactLabel=root.querySelector("[data-interactive-toggle-compact]");let active=false;const replaceFrame=(url,sandbox)=>{const current=root.querySelector(".artifact-frame--html");if(!current)return;const next=current.cloneNode(false);next.setAttribute("sandbox",sandbox);next.src=url;current.replaceWith(next);window.dispatchEvent(new Event("artifactpass:html-frame-replaced"))};const setActive=(nextActive)=>{active=nextActive;const action=active?"Disable JavaScript":"Enable JavaScript";root.dataset.interactiveActive=String(active);toggle.setAttribute("aria-label",action);toggle.setAttribute("aria-pressed",String(active));fullLabel.textContent=action;compactLabel.textContent=active?"Disable":"Enable";replaceFrame(active?root.dataset.htmlInteractiveUrl:root.dataset.htmlPreviewUrl,active?"allow-scripts":"")};toggle.addEventListener("click",()=>setActive(!active))})();`;

export const renderSharePage = ({
  manifest,
  nonce,
  representation,
  sharePath,
}: SharePageOptions): string => {
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
          <main className="viewer-main">
            <section className="viewer-shell" aria-labelledby="artifact-title">
              <div className="viewer-toolbar">
                <a className="viewer-home" href={publicSiteUrl()} aria-label="ArtifactPass home">
                  <ArtifactPassIcon className="viewer-home-mark" aria-hidden="true" focusable="false" />
                  <span className="viewer-home-label">ArtifactPass</span>
                </a>
                <div className="viewer-identity">
                  <strong className="viewer-filename" id="artifact-title">{manifest.filename}</strong>
                  <span className="viewer-meta" aria-label="Artifact details">
                    <span>{formatType(manifest.mime_type)} · {formatBytes(manifest.byte_size)}</span>
                    <span data-expiry-countdown>Time left</span>
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
                  <button
                    className="viewer-theme"
                    id="theme-toggle"
                    type="button"
                    aria-label="Switch to light mode"
                    aria-pressed="true"
                    title="Switch to light mode"
                  >
                    <ThemeIcon className="viewer-theme-icon" aria-hidden="true" focusable="false" />
                  </button>
                  <a className="download" href={`${sharePath}/raw`} download={manifest.filename}>Download</a>
                </div>
              </div>
              <div className="viewer" aria-label={`${formatType(manifest.mime_type)} viewer`}>
                {representation.kind === "markdown" && <MarkdownViewer html={representation.html} source={representation.source} />}
                {representation.kind === "html" && (
                  <HtmlViewer
                    interactiveUrl={representation.interactiveUrl}
                    previewUrl={representation.previewUrl}
                    source={representation.source}
                  />
                )}
                {representation.kind === "pdf" && <PdfViewer sourceUrl={representation.sourceUrl} />}
              </div>
            </section>
          </main>
        </div>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: viewerModeScript }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInteractionScript }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: htmlZoomScript }} />
        {representation.kind === "html" && representation.interactiveUrl !== undefined && (
          <script nonce={nonce} dangerouslySetInnerHTML={{ __html: htmlInteractiveScript }} />
        )}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: expiryScript }} />
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
};
