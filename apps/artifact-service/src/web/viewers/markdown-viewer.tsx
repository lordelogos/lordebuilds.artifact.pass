export function MarkdownViewer({
  html,
  source,
}: {
  readonly html: string;
  readonly source: string;
}) {
  return (
    <>
      <section className="viewer-panel" id="viewer-panel-rendered" data-viewer-panel="rendered" role="tabpanel">
        <article className="artifact-prose" dangerouslySetInnerHTML={{ __html: html }} />
      </section>
      <section className="viewer-panel" id="viewer-panel-raw" data-viewer-panel="raw" role="tabpanel" hidden>
        <pre className="artifact-source"><code>{source}</code></pre>
      </section>
    </>
  );
}
