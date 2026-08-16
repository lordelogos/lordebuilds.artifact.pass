export function HtmlViewer({ source }: { readonly source: string }) {
  return (
    <iframe
      className="artifact-frame"
      title="Sanitized HTML preview"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={source}
    />
  );
}
