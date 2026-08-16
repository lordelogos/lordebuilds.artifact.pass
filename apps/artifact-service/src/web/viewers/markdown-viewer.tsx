export function MarkdownViewer({ html }: { readonly html: string }) {
  return <article className="artifact-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
