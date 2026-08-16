import { Hono } from "hono";

const app = new Hono();

app.get("/health", (context) =>
  context.json({
    service: "lordebuilds.artifacts.share",
    status: "ok",
  }),
);

export default app;
