import { Hono } from "hono";

import type { ArtifactServiceBindings } from "./adapters/cloudflare-bindings";

const app = new Hono<{ Bindings: ArtifactServiceBindings }>();

app.get("/health", (context) =>
  context.json({
    service: "lordebuilds.artifacts.share",
    status: "ok",
  }),
);

export default app;
