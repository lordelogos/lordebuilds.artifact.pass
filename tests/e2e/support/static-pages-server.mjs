import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve("apps/artifact-pages/dist");
const headersSource = readFileSync(join(root, "_headers"), "utf8");
const routeHeaders = new Map(
  headersSource.trim().split(/\n\s*\n/u).map((block) => {
    const [route, ...lines] = block.split("\n");
    return [route, Object.fromEntries(lines.map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }))];
  }),
);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const fileForPath = (pathname) => {
  const cleanPath = pathname === "/" ? "/index" : pathname.replace(/\/$/u, "");
  const relative = cleanPath.slice(1);
  const candidate = extname(relative) === "" ? `${relative}.html` : relative;
  const target = normalize(join(root, candidate));
  return target.startsWith(`${root}/`) ? target : null;
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const file = fileForPath(pathname);
  if (file === null) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    if (!statSync(file).isFile()) throw new Error("Not a file");
  } catch {
    response.writeHead(404).end("Not found");
    return;
  }
  const headers = {
    "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
    ...routeHeaders.get(pathname),
  };
  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
});

server.listen(4174, "127.0.0.1");

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
