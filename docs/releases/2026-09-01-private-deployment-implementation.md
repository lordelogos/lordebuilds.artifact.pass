# Private deployment implementation qualification

Date: 2026-09-01

Implementation status: core flow complete; U8 qualification partial

Release readiness: blocked-on-remaining-U8-live-qualification

This record covers the isolated staging rehearsal for private ArtifactPass onboarding. It proves the implementation against real Cloudflare resources under the existing ArtifactPass account and domain. It does not claim the unrelated-account, fresh-domain journey required for release.

## Candidate

- Workspace version: `0.1.0-rc.12`
- Source baseline before this evidence update: `973c2539e99a860d07c255b18e084eed67ff8a48`
- Portable integration SHA-256: `638e64453a29c4b6c1b294471a71b28c353c00e42416b251b7f26c8fd578a22c`
- Locally packed, unpublished tarball SHA-256: `13d78e726a04bc756e2c60a463f9aee2f29b2880152155d460a4339d8cbb789a` (staging-only; not release-qualifying)
- Node.js: `v24.16.0`
- pnpm: `10.11.0`
- Production npm provenance: not asserted by this staging rehearsal
- Production Cloudflare OAuth client: not qualified by this staging rehearsal

The Git commit containing this record is the source commit for the qualified evidence below. It is not yet the implementation-complete U8 candidate. After the remaining production OAuth gate passes, a future U9 run must freeze a published candidate, registry integrity, tarball digest, immutable tag, production OAuth client, and service deployment identity before it starts.

## Isolated staging environment

- Hostname: `private-qualification-staging.artifactpass.com`
- Deployment ID: `33b4d5a1-83e5-4187-9a9f-a3938ab20013`
- Worker service: `artifactpass-33b4d5a1`
- Worker script tag after the final idempotent rerun: `9f84c55f9b334d1e99dc616db6662009`
- Hosted verification after the final idempotent rerun: `2026-09-02T01:05:58.130Z`
- Identity: Cloudflare Access email-code login
- Retention choices: 15 minutes, 30 minutes, 60 minutes, 24 hours, and 7 days
- Doctor result: `healthy`

No account ID, zone ID, email address, OAuth material, device code, token, private key, artifact contents, or live share URL is recorded here.

## Live evidence

- Cloudflare Access protected the private upload page and completed email-code sign-in.
- A clean isolated teammate configuration installed the same portable MCP and Agent Skills integration without host-specific product code.
- The installed integration exposed exactly `connect_artifactpass`, `connection_status`, `publish_artifact`, and `read_artifact`.
- Explicit browser approval bound the agent credential to the private origin, workspace, and locally generated device key.
- A live agent published Markdown and reconstructed the exact 115 source bytes. The source and manifest SHA-256 values matched.
- Codex-to-Claude and Claude-to-Codex private handoffs both used the same portable four-tool integration, checked connection status before publication, invoked the required publish and read tools, removed the publisher source before the read, and reconstructed the exact bytes. The strict lifecycle report is sealed in the external release lab as `reports/private-u8-cross-agent-strict-lifecycle-handoff.json`.
- A live browser uploaded a Markdown document and reached the final shared-link state.
- A hostile HTML upload rendered only inside the sandbox. Script execution, automatic navigation, form behavior, unsafe links, and external resource requests remained blocked.
- The 15-minute agent artifact was present in D1 and R2 before its cutoff, remained exactly readable immediately before expiry, and became unreadable after the cutoff. The next scheduled cleanup removed both its D1 metadata row and its R2 objects.
- An identical deployment rerun completed successfully and retained exactly one Worker service, one D1 database, one R2 bucket, and one Access application.
- Resume resolution remained healthy from an unrelated working directory.
- Deliberate Cloudflare OAuth revocation removed the local grant, doctor failed closed as `authorization-required`, and fresh consent restored a healthy deployment without replacing its D1, R2, or Access resources.
- The earlier live Cloudflare 503 occurred before any resource mutation, recorded zero changed resources, and the same deployment subsequently resumed and passed hosted verification. This proves failure-before-mutation containment, not the post-mutation rollback path.
- A before-and-after identity digest and exact resource counts for the existing public D1, R2, Worker, and Access resources were identical. This proves the expected public resource identities remained present; it does not prove their mutable contents or configuration were unchanged.
- Doctor reattested the deployment as healthy after the rerun.

The staging rehearsal also exposed a short-lived macOS negative-DNS-cache failure immediately after hostname activation. The product fix now retries only DNS-not-found and temporary-DNS errors through Cloudflare's public resolver, preserves TLS hostname verification, rejects private fallback addresses, refuses redirects, and caps fallback responses at 2 MiB. The live agent connection and publish/read flow passed after that fix.

## Automated evidence

- `pnpm release:check`: passed. Secret scanning, distribution controls, lint, typecheck, 661 tests, production builds, license review, dependency audit, and package inspection all passed.
- `pnpm test:packed-install`: passed. Install, MCP smoke, receipt validation, and rerun repair passed from packed contents.
- `pnpm test:browser`: passed with 24 tests and 7 explicitly skipped live-only tests.
- `pnpm test:agent-contract`: passed with the stdio MCP smoke test and five portability tests.
- `pnpm test:agent-hosts`: passed for Codex and Claude Code using the same five-file portable package.
- Candidate-digest configuration test: passed after the portable integration digest was updated.
- Private deployment state and rollback suite: 196 tests passed, including saved-checkpoint resume, authorization loss, manifest drift refusal before mutation, rollback containment, and installer rollback.
- External host acceptance lab: 118 tests passed after the Claude publisher was allowed the complete connection lifecycle (`connection_status`, `connect_artifactpass`, then `publish_artifact`).

The local build warns that the public Google and GitHub OAuth client secrets are absent. That warning is expected for this private-mode build and did not bypass or weaken the private Cloudflare Access checks.

## Evidence boundaries

This run used isolated names under the current ArtifactPass Cloudflare account and domain. It did not prove:

- first-time Cloudflare account onboarding by an unrelated administrator;
- a fresh registrar-controlled domain and nameserver change;
- the public production OAuth client and published npm candidate;
- the separate API-token fallback journey.

Those claims remain assigned to U9. Any package, OAuth-client, service, evaluator, or product-code change after the U9 candidate is frozen invalidates that external evidence and requires a complete rerun.

Live staging proved cross-folder resume, authorization revocation and recovery, a real zero-mutation Cloudflare failure checkpoint, scheduled D1/R2 deletion, and stable public resource identities and counts. Automated suites prove saved-checkpoint interruption, approved-manifest drift refusal, and rollback behavior, but those automated results are not presented as live Cloudflare proof.

The remaining U8 blockers are:

- live interruption and resume at the saved Cloudflare checkpoints required by the plan;
- live approved-manifest drift refusal before mutation;
- live post-mutation rollback containment with the previously verified Worker remaining usable;
- a before-and-after mutable-state or audit-log proof that the public Worker, D1, R2, Access application, DNS, and OAuth clients were not changed;
- completion and qualification of the production Cloudflare OAuth client. The package still has no production client ID, the current production site returns `404` for `/privacy`, `/terms`, and a hosted logo asset, and the existing staging OAuth client remains private with domain verification in progress.

The production client must use the loopback PKCE redirect, exact required scopes, verified ArtifactPass domain, visual identity, privacy and terms URLs, and support contact before U8 can become implementation-complete.

The cross-agent run used the locally packed candidate because the published `0.1.0-rc.12` predates the DNS transport fix in the source baseline. That proof is valid staging behavior evidence but is explicitly not npm release-qualification evidence. A later candidate must receive a new version and registry provenance before U9 is frozen.

## Decision

The core private deployment flow and the live staging behaviors listed above are proven. U8 remains partial because the remaining live gates and production OAuth prerequisites are unfinished. U9 must not begin until those blockers are closed, the DNS transport fix is issued under a new candidate version, and a new implementation-complete candidate record is sealed. The eventual external procedure is documented in [private deployment release qualification](../private-deployment-qualification.md).
