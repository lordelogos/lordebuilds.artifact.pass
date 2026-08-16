# Browser verification

The automated Worker suite exercises browser-route authorization with a signed test assertion and local D1/R2 bindings. It does not weaken the production Access boundary or add a development bypass.

The Playwright flow is the replacement verification for the real browser and Cloudflare Access boundary. Run it against an Access-protected development deployment:

1. Install the pinned browser once with `pnpm exec playwright install chromium`.
2. Save an authenticated Cloudflare Access browser session outside the repository:
   `pnpm exec playwright codegen --save-storage=/tmp/artifact-share-access.json https://artifacts-dev.example.com/upload`
3. Complete Access login, confirm the upload page appears, then close the codegen browser.
4. Run:
   `ARTIFACT_SHARE_E2E_BASE_URL=https://artifacts-dev.example.com ARTIFACT_SHARE_E2E_STORAGE_STATE=/tmp/artifact-share-access.json pnpm test:browser`

The suite uploads all three formats, reads the public bearer link, verifies clipboard behavior, checks that hostile HTML makes no external request or same-origin escape, checks PDF range and download responses, and confirms dashboard/history/settings routes do not exist. The storage-state file contains live Access credentials; never place it in the repository, logs, or a model prompt. Delete it when verification is complete.

For a local visual pass without an Access bypass, build the app, serve `apps/artifact-service/dist/client`, and set `ARTIFACT_SHARE_PREVIEW_URL` to that static origin. The preview suite changes the browser pathname before the production client starts and mocks only browser network responses. It captures desktop/mobile screenshots and runs the production PDF extraction Web Worker against a born-digital fixture; it does not exercise or alter Worker authorization.
