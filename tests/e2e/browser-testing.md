# Browser verification

The automated Worker suite exercises browser-route authorization with a signed test assertion and local D1/R2 bindings. It does not weaken the production Access boundary or add a development bypass.

The Playwright flow is the replacement verification for the real browser and Cloudflare Access boundary. Run it against an Access-protected development deployment:

1. Install the pinned browser once with `pnpm exec playwright install chromium`.
2. Save an authenticated Cloudflare Access browser session outside the repository:
   `pnpm exec playwright codegen --save-storage=/tmp/artifact-share-access.json https://artifacts-dev.example.com/upload`
3. Complete Access login, confirm the upload page appears, then close the codegen browser.
4. Retrieve a disposable scoped agent token from the operating-system credential store without printing it or saving it in the repository.
5. Run the command in [operations](../../docs/operations.md#live-release-gate).

The live suite uploads all three formats, reads the public bearer link, verifies clipboard behavior, checks that hostile HTML makes no external request or same-origin escape, checks PDF range and download responses, confirms dashboard/history/settings routes do not exist, and performs one large exact-source handoff between two independent clients. The storage-state file and agent token contain live credentials; never place either in the repository, logs, traces, or a model prompt. Delete the storage state and disconnect the disposable token when verification is complete.

`pnpm test:browser` starts the local Vite client automatically. The preview suite opens the real `/upload` client route and mocks only browser network responses. It captures desktop/mobile screenshots and runs the production PDF extraction Web Worker against born-digital and image-only fixtures; it does not exercise or alter Worker authorization. Set `ARTIFACT_SHARE_PREVIEW_URL` only when testing another static client origin.
