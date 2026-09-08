import { ZoomInIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export function HtmlViewer({
  interactiveUrl,
  previewUrl,
  source,
}: {
  readonly interactiveUrl: string | undefined;
  readonly previewUrl: string;
  readonly source: string;
}) {
  return (
    <>
      <section className="viewer-panel" id="viewer-panel-preview" data-viewer-panel="preview" role="tabpanel">
        <div
          className={`html-preview${interactiveUrl === undefined ? " html-preview--static" : ""}`}
          data-html-preview
          data-html-preview-url={previewUrl}
          data-html-interactive-url={interactiveUrl}
        >
          {interactiveUrl !== undefined && (
            <div className="interactive-banner">
              <span className="interactive-symbol" aria-hidden="true">
                JS
              </span>
              <span className="interactive-copy">
                <strong data-interactive-title>This file contains JavaScript</strong>
              </span>
              <button
                className="interactive-toggle"
                type="button"
                data-interactive-toggle
                aria-label="Enable JavaScript"
                aria-pressed="false"
              >
                <span className="interactive-toggle-label--full" data-interactive-toggle-full>Enable JavaScript</span>
                <span className="interactive-toggle-label--compact" data-interactive-toggle-compact aria-hidden="true">Enable</span>
              </button>
            </div>
          )}
          <div className="html-preview-viewport" data-html-preview-viewport>
            <div className="html-zoom-menu" data-html-zoom-menu>
              <button
                className="html-zoom-trigger"
                type="button"
                aria-label="Show zoom controls"
                aria-expanded="false"
                title="Zoom controls"
                data-html-zoom-trigger
              >
                <HugeiconsIcon icon={ZoomInIcon} size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <div className="html-zoom-controls" role="group" aria-label="HTML preview zoom" hidden>
                <button className="html-zoom-button html-zoom-fit" type="button" data-html-zoom="fit" aria-pressed="false">Fit</button>
                <span className="html-zoom-divider" aria-hidden="true" />
                <button className="html-zoom-button html-zoom-step" type="button" data-html-zoom="out" aria-label="Zoom out">−</button>
                <button className="html-zoom-button html-zoom-value" type="button" data-html-zoom="reset" aria-label="Reset zoom to 100%">100%</button>
                <button className="html-zoom-button html-zoom-step" type="button" data-html-zoom="in" aria-label="Zoom in">+</button>
              </div>
            </div>
            <iframe
              className="artifact-frame artifact-frame--html"
              title="HTML page preview"
              sandbox=""
              referrerPolicy="no-referrer"
              src={previewUrl}
            />
          </div>
        </div>
      </section>
      <section className="viewer-panel" id="viewer-panel-source" data-viewer-panel="source" role="tabpanel" hidden>
        <pre className="artifact-source artifact-source--html"><code>{source}</code></pre>
      </section>
    </>
  );
}
