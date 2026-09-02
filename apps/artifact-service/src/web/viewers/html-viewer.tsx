export function HtmlViewer({
  previewUrl,
  source,
}: {
  readonly previewUrl: string;
  readonly source: string;
}) {
  return (
    <>
      <section className="viewer-panel" id="viewer-panel-preview" data-viewer-panel="preview" role="tabpanel">
        <div className="html-preview" data-html-preview>
          <div className="html-zoom-controls" role="group" aria-label="HTML preview zoom">
            <button className="html-zoom-button html-zoom-fit" type="button" data-html-zoom="fit" aria-pressed="false">Fit</button>
            <span className="html-zoom-divider" aria-hidden="true" />
            <button className="html-zoom-button html-zoom-step" type="button" data-html-zoom="out" aria-label="Zoom out">−</button>
            <button className="html-zoom-button html-zoom-value" type="button" data-html-zoom="reset" aria-label="Reset zoom to 100%">100%</button>
            <button className="html-zoom-button html-zoom-step" type="button" data-html-zoom="in" aria-label="Zoom in">+</button>
          </div>
          <div className="html-preview-viewport" data-html-preview-viewport>
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
