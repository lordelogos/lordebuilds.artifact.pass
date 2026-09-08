import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import { marked } from "marked";
import type { Element, ElementContent, Properties, RootContent } from "hast";

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

const discardFromHtmlPreview = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "applet",
  "base",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "link",
  "object",
  "portal",
  "script",
  "set",
]);

const navigationProperties = new Set([
  "action",
  "archive",
  "background",
  "cite",
  "classid",
  "codebase",
  "data",
  "download",
  "formaction",
  "href",
  "icon",
  "longdesc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "referrerpolicy",
  "srcdoc",
  "srcset",
  "target",
  "usemap",
  "xlinkhref",
]);

const formControls = new Set([
  "button",
  "fieldset",
  "input",
  "optgroup",
  "option",
  "select",
  "textarea",
]);

const safeEmbeddedUrl = /^(?:#|data:(?:image\/(?:avif|gif|jpeg|png|webp)|font\/(?:otf|ttf|woff2?)|application\/(?:font-woff|vnd\.ms-fontobject)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|text\/vtt)[;,])/iu;

const isSafeEmbeddedSource = (value: unknown): boolean =>
  typeof value === "string" && safeEmbeddedUrl.test(value.trim());

const neutralizeCssResources = (source: string): string =>
  source
    .replace(/@import\b[^;{}]*(?:;|$)/giu, "")
    .replace(
      /url\(\s*(?:(['"])(.*?)\1|([^)]*))\s*\)/giu,
      (match, _quote: string | undefined, quoted: string | undefined, unquoted: string | undefined) => {
        const value = (quoted ?? unquoted ?? "").trim();
        return safeEmbeddedUrl.test(value) ? match : "none";
      },
    );

const neutralizePreviewProperties = (element: Element): Properties => {
  const properties: Properties = {};
  for (const [name, value] of Object.entries(element.properties)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName.startsWith("on")) continue;
    if (navigationProperties.has(normalizedName)) continue;
    if (normalizedName === "src" && !isSafeEmbeddedSource(value)) continue;
    properties[name] = normalizedName === "style" && typeof value === "string"
      ? neutralizeCssResources(value)
      : value;
  }
  if (element.tagName === "form") {
    properties.inert = true;
    properties.ariaDisabled = "true";
  }
  if (formControls.has(element.tagName)) {
    properties.disabled = true;
  }
  if (element.tagName === "button") {
    properties.type = "button";
  }
  if (element.tagName === "a" || element.tagName === "area") {
    properties.ariaDisabled = "true";
    properties.tabIndex = -1;
  }
  return properties;
};

const neutralizePreviewNode = (node: RootContent): readonly RootContent[] => {
  if (node.type === "text") return [{ type: "text", value: node.value }];
  if (node.type === "doctype") return [{ type: "doctype" }];
  if (node.type !== "element") return [];
  if (discardFromHtmlPreview.has(node.tagName)) return [];
  if (node.tagName === "meta" && Object.keys(node.properties).some((name) => name.toLowerCase() === "httpequiv")) {
    return [];
  }
  const neutralized: Element = {
    type: "element",
    tagName: node.tagName,
    properties: neutralizePreviewProperties(node),
    children: node.tagName === "style"
      ? node.children.flatMap((child) => child.type === "text"
        ? [{ type: "text" as const, value: neutralizeCssResources(child.value) }]
        : [])
      : node.children.flatMap((child) => neutralizePreviewNode(child)) as ElementContent[],
  };
  return [neutralized];
};

const containsJavaScript = (node: RootContent): boolean => {
  if (node.type !== "element") return false;
  if (node.tagName === "script") return true;
  const hasExecutableProperty = Object.entries(node.properties).some(([name, value]) =>
    name.toLowerCase().startsWith("on")
    || (typeof value === "string" && /^\s*javascript:/iu.test(value))
  );
  return hasExecutableProperty || node.children.some((child) => containsJavaScript(child));
};

export const renderSafeMarkdown = (source: string): string => {
  const rendered = marked.parse(source, {
    async: false,
    gfm: true,
  });
  return sanitizeReadableMarkup(rendered);
};

export const renderSafeHtmlPreview = (source: string): string => {
  const parsed = fromHtml(source);
  return toHtml({
    type: "root",
    children: parsed.children.flatMap((node) => neutralizePreviewNode(node)),
  });
};

export const htmlContainsJavaScript = (source: string): boolean => {
  const parsed = fromHtml(source);
  return parsed.children.some((node) => containsJavaScript(node));
};
