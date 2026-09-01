# Private deployment implementation qualification

Date: 2026-09-01

Implementation status: core flow complete; U8 qualification partial

Release readiness: blocked-on-remaining-U8-live-qualification

This record covers the isolated staging rehearsal for private ArtifactPass onboarding. It proves the implementation against real Cloudflare resources under the existing ArtifactPass account and domain. It does not claim the unrelated-account, fresh-domain journey required for release.

## Candidate

- Workspace version: `0.1.0-rc.12`
- Source baseline before this evidence commit: `4b04ba4d378ad093a663cd7adcdee1323598dee6`
- Portable integration SHA-256: `638e64453a29c4b6c1b294471a71b28c353c00e42416b251b7f26c8fd578a22c`
- Node.js: `v24.16.0`
- pnpm: `10.11.0`
- Production npm provenance: not asserted by this staging rehearsal
- Production Cloudflare OAuth client: not qualified by this staging rehearsal

The Git commit containing this record is the source commit for the qualified evidence below. It is not yet the implementation-complete U8 candidate. After the remaining U8 gates pass, a future U9 run must freeze a published candidate, registry integrity, tarball digest, immutable tag, production OAuth client, and service deployment identity before it starts.

## Isolated staging environment

- Hostname: `private-qualification-staging.artifactpass.com`
- Deployment ID: `33b4d5a1-83e5-4187-9a9f-a3938ab20013`
- Worker service: `artifactpass-33b4d5a1`
- Worker script tag after idempotent rerun: `9f84c55f9b334d1e99dc616db6662009`
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
- A live browser uploaded a Markdown document and reached the final shared-link state.
- A hostile HTML upload rendered only inside the sandbox. Script execution, automatic navigation, form behavior, unsafe links, and external resource requests remained blocked.
- The 15-minute agent artifact became unreadable after its exact cutoff.
- An identical deployment rerun completed successfully and retained exactly one Worker service, one D1 database, one R2 bucket, and one Access application.
- Doctor reattested the deployment as healthy after the rerun.

The staging rehearsal also exposed a short-lived macOS negative-DNS-cache failure immediately after hostname activation. The product fix now retries only DNS-not-found and temporary-DNS errors through Cloudflare's public resolver, preserves TLS hostname verification, rejects private fallback addresses, refuses redirects, and caps fallback responses at 2 MiB. The live agent connection and publish/read flow passed after that fix.

## Automated evidence

- `pnpm release:check`: passed. Secret scanning, distribution controls, lint, typecheck, 661 tests, production builds, license review, dependency audit, and package inspection all passed.
- `pnpm test:packed-install`: passed. Install, MCP smoke, receipt validation, and rerun repair passed from packed contents.
- `pnpm test:browser`: passed with 24 tests and 7 explicitly skipped live-only tests.
- `pnpm test:agent-contract`: passed with the stdio MCP smoke test and five portability tests.
- `pnpm test:agent-hosts`: passed for Codex and Claude Code using the same five-file portable package.
- Candidate-digest configuration test: passed after the portable integration digest was updated.

The local build warns that the public Google and GitHub OAuth client secrets are absent. That warning is expected for this private-mode build and did not bypass or weaken the private Cloudflare Access checks.

## Evidence boundaries

This run used isolated names under the current ArtifactPass Cloudflare account and domain. It did not prove:

- first-time Cloudflare account onboarding by an unrelated administrator;
- a fresh registrar-controlled domain and nameserver change;
- the public production OAuth client and published npm candidate;
- the separate API-token fallback journey.

Those claims remain assigned to U9. Any package, OAuth-client, service, evaluator, or product-code change after the U9 candidate is frozen invalidates that external evidence and requires a complete rerun.

This staging run also did not complete every U8 live qualification gate. The following remain U8 blockers rather than U9 work:

- live cross-agent private handoff using separate representative hosts;
- interruption and resume at each saved Cloudflare checkpoint;
- live Cloudflare authorization revocation and recovery;
- approved-manifest drift rejection before mutation;
- rollback containment with the previously verified Worker remaining usable;
- scheduled physical deletion from both D1 and R2 after expiry;
- a resource inventory proving the private rehearsal did not mutate current public resources;
- completion and qualification of the production Cloudflare OAuth client, including privacy and terms URLs, redirects, visual identity, scopes, and support contact.

Automated suites cover interruption, revocation, drift, rollback, and cleanup logic, but that is not presented as live staging proof.

## Decision

The core private deployment flow is implemented and its primary staging journey is proven. U8 qualification remains partial because the live gates listed above are outstanding. U9 must not begin until those U8 blockers are closed and a new implementation-complete candidate record is sealed. The eventual external procedure is documented in [private deployment release qualification](../private-deployment-qualification.md).
