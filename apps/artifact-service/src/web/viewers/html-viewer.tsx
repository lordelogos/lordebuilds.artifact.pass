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
        <iframe
          className="artifact-frame"
          title="HTML page preview"
          sandbox=""
          referrerPolicy="no-referrer"
          src={previewUrl}
        />
      </section>
      <section className="viewer-panel" id="viewer-panel-source" data-viewer-panel="source" role="tabpanel" hidden>
        <pre className="artifact-source artifact-source--html"><code>{source}</code></pre>
      </section>
    </>
  );
}
