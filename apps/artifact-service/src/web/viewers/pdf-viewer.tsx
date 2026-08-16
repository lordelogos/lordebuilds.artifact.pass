export function PdfViewer({ sourceUrl }: { readonly sourceUrl: string }) {
  return (
    <iframe
      className="artifact-frame artifact-frame--pdf"
      title="PDF preview"
      sandbox=""
      referrerPolicy="no-referrer"
      src={sourceUrl}
    />
  );
}
