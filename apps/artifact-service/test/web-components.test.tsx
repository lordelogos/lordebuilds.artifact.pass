import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExpiryPicker } from "../src/web/components/expiry-picker";
import { FileDrop } from "../src/web/components/file-drop";
import { validateBrowserFile } from "../src/web/routes/upload-page";

describe("browser upload components", () => {
  it("renders a single-file drop target and accessible picker", () => {
    const html = renderToStaticMarkup(
      <FileDrop disabled={false} file={null} onFile={() => undefined} />,
    );

    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".html,.htm,.md,.markdown,.pdf,text/html,text/markdown,application/pdf"');
    expect(html).not.toContain("multiple");
    expect(html).toContain("Choose a file");
  });

  it("derives every expiry choice from deployment policy", () => {
    const html = renderToStaticMarkup(
      <ExpiryPicker
        disabled={false}
        options={[900, 1800, 3600]}
        value={1800}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('value="900"');
    expect(html).toContain('value="1800" selected=""');
    expect(html).toContain('value="3600"');
    expect(html).not.toContain('value="86400"');
  });

  it("rejects unsupported, mismatched and oversized files before upload", async () => {
    await expect(
      validateBrowserFile(
        new File(["plain"], "notes.txt", { type: "text/plain" }),
        1024,
      ),
    ).resolves.toBe("Only HTML, Markdown, and PDF files are supported.");

    await expect(
      validateBrowserFile(
        new File(["# heading"], "notes.pdf", { type: "text/markdown" }),
        1024,
      ),
    ).resolves.toBe("The filename extension does not match the file type.");

    await expect(
      validateBrowserFile(
        new File(["too large"], "notes.md", { type: "text/markdown" }),
        4,
      ),
    ).resolves.toBe("This file is larger than the deployment allows.");
  });
});
