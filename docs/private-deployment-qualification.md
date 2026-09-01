# Private deployment release qualification

This procedure is the final release gate for private deployment onboarding. It must be run by a first-time administrator using an unrelated Cloudflare account and a fresh registrar-controlled domain. Passing automated tests or an isolated subdomain rehearsal does not replace it.

## Freeze the candidate

Before the run, record:

- npm package name and exact release-candidate version;
- registry integrity and downloaded tarball SHA-256;
- source commit and immutable release tag;
- GitHub Actions run and npm provenance statement;
- production Cloudflare OAuth client ID and redirect URI;
- production ArtifactPass service deployment identity;
- Node.js, pnpm, operating system, and agent-host versions;
- start time and the identity of the independent administrator.

The administrator must run the exact version:

```sh
pnpm dlx artifactpass@0.1.0-rc.N deploy
```

Replace `N` with the frozen candidate. Do not use an unpinned tag such as `rc` or `latest` during qualification.

## External prerequisites

The run needs:

- a Cloudflare account unrelated to the ArtifactPass operator account;
- a fresh domain whose registrar nameservers can be changed;
- an administrator who has not used the private setup flow before;
- a second teammate identity allowed by the chosen email rule;
- one supported agent host for the admin and a different supported host or machine for the teammate;
- Markdown, hostile HTML, human PDF, and controlled PDF fixtures with no confidential data.

Cloudflare plan selection, billing, payment methods, nameserver changes, and company identity-provider administration remain human actions in Cloudflare or the registrar. ArtifactPass must open the correct page and resume when the prerequisite becomes ready.

## Default OAuth journey

1. Start from a clean local ArtifactPass deployment state and no saved Cloudflare deployment grant.
2. Run the pinned command and choose the target domain, private hostname, sign-in method, publisher audience, and retention presets.
3. Complete ArtifactPass's production Cloudflare OAuth authorization. Record the client ID, redirect URI, granted scopes, and successful return without recording codes or tokens.
4. Add the fresh domain and change nameservers at the registrar. Stop the CLI, move to another folder, and resume by hostname after Cloudflare marks the zone Active.
5. Activate R2 and Zero Trust only through Cloudflare's UI. Confirm ArtifactPass never accepts a plan or changes billing.
6. Configure email-code or an existing company login. Confirm the final Access policy permits only the approved domains, addresses, or selected provider.
7. Review the approval summary and deploy the exact approved manifest.
8. Confirm one Worker, one D1 database, one private R2 bucket, one Access application, the expected policy, migrations, cron, and lifecycle policy exist.
9. Run deployment doctor. It must report `healthy` without mutation.
10. Upload Markdown, hostile HTML, a human PDF, and a controlled PDF. Confirm source/download fidelity, safe viewer behavior, expiry choices, and the controlled-PDF agent boundary.
11. Install the printed teammate command in a clean workspace. Confirm it installs disconnected, opens the private deployment on first use, completes Access login, and requires explicit device approval.
12. Publish from one agent and read the exact artifact from the other. Record hashes and semantic assertions, not the live bearer URL.
13. Let a short artifact reach its exact cutoff. Confirm every representation is unavailable and scheduled cleanup removes D1/R2 state.
14. Run the identical deployment command again. Confirm it reuses the recorded resources and creates no duplicates.
15. Interrupt and resume at each saved handoff class: domain, R2, Zero Trust, and identity provider. Confirm completed checkpoints are not repeated.
16. Revoke Cloudflare authorization and confirm doctor reports `authorization-required` without querying Cloudflare. Reauthorize and confirm health returns.
17. Change one approved input or remote ownership marker in a disposable copy. Confirm manifest drift requires reapproval and resource conflict fails closed.
18. Exercise repair and rollback containment. A failed deployment must leave the previous verified Worker usable or mark the state `repair-required` with an exact next action.

## Separate API-token fallback

If the OAuth path cannot complete, record the failure and stop the default journey. A separately authorized, short-lived API-token fallback may be tested for supportability, but it receives its own record and cannot make the default OAuth gate pass.

Never place the token in command history, a deployment state file, a receipt, a log, or the release record.

## Evidence record

Write one redacted JSON or Markdown record under `docs/releases/` with these sections:

```json
{
  "candidate": {
    "version": "0.1.0-rc.N",
    "tag": "v0.1.0-rc.N",
    "commit": "full commit SHA",
    "registry_integrity": "sha512-...",
    "tarball_sha256": "hex digest",
    "provenance_verified": true
  },
  "authorization": {
    "journey": "production-oauth",
    "client_id": "public client ID",
    "redirect_uri": "http://127.0.0.1:8976/oauth/callback",
    "scopes_match_reviewed_profile": true
  },
  "environment": {
    "cloudflare_account_relation": "unrelated",
    "domain_relation": "fresh",
    "administrator_relation": "first-time"
  },
  "gates": {
    "domain_and_nameservers": "passed",
    "r2_and_zero_trust": "passed",
    "identity": "passed",
    "deployment": "passed",
    "browser_and_agent": "passed",
    "expiry_and_cleanup": "passed",
    "idempotency": "passed",
    "repair_and_rollback": "passed"
  },
  "fallback_token_journey": "not-run",
  "result": "passed"
}
```

Do not record account IDs, zone IDs, email addresses, OAuth codes, tokens, device codes, private keys, artifact contents, or live share URLs in a public release record.

## Invalidation rule

Any product code change, package rebuild, version change, OAuth-client change, service change, evaluator change, or engineering intervention invalidates the run. Fix the issue, publish a new candidate, and restart from step 1. Product code changes are forbidden during a qualifying run.

Private deployment becomes release-ready only when this exact default journey passes. Until then, implementation may be complete and staging may be healthy, but the release record must say `blocked-on-fresh-domain-qualification`.
