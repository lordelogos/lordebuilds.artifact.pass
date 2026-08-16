import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import { marked } from "marked";
import type { Element, ElementContent, RootContent } from "hast";

const readableTags = [
  "article",
  "aside",
  "blockquote",
  "br",
  "code",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

const allowedTagNames = new Set<string>(readableTags);
const discardWithContents = new Set(["script", "style", "textarea", "option", "noscript"]);

const cleanNode = (node: RootContent): readonly ElementContent[] => {
  if (node.type === "text") return [{ type: "text", value: node.value }];
  if (node.type !== "element") return [];
  if (discardWithContents.has(node.tagName)) return [];
  const children = node.children.flatMap((child) => cleanNode(child));
  if (!allowedTagNames.has(node.tagName)) return children;
  const cleanElement: Element = {
    type: "element",
    tagName: node.tagName,
    properties: {},
    children,
  };
  return [cleanElement];
};

const sanitizeReadableMarkup = (source: string): string => {
  const parsed = fromHtml(source, { fragment: true });
  return toHtml({ type: "root", children: parsed.children.flatMap((node) => cleanNode(node)) });
};

export const renderSafeMarkdown = (source: string): string => {
  const rendered = marked.parse(source, {
    async: false,
    gfm: true,
  });
  return sanitizeReadableMarkup(rendered);
};

export const renderSafeHtmlPreview = (source: string, nonce: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style nonce="${nonce}">body{margin:0;padding:28px;color:#24241f;background:#fffefa;font:16px/1.65 Georgia,serif}pre,code{white-space:pre-wrap;font-family:monospace}table{border-collapse:collapse}th,td{padding:8px;border:1px solid #d8d5ca}</style></head><body>${sanitizeReadableMarkup(source)}</body></html>`;
