# Private deployment OAuth qualification

This qualification answers one question before ArtifactPass builds its private-deployment wizard:

> Can a public OAuth client obtain only the Cloudflare permissions needed by each setup mode, use those credentials with both Cloudflare's API and Wrangler, and revoke them cleanly?

If the answer is no, ArtifactPass must not quietly replace OAuth with a broad API token. The authorization architecture returns to planning.

## Staging OAuth client

The staging client is private to the current Cloudflare account. It is configured as follows:

| Field | Value |
|---|---|
| Name | `artifactpass-private-deploy-staging` |
| Response type | Authorization code |
| Grant types | Authorization code, refresh token |
| Token authentication | None, using PKCE |
| Redirect URL | `http://127.0.0.1:8976/oauth/callback` |
| Client URL | `https://staging.artifactpass.com` |

The fixed callback is deliberate. The qualification runner binds only to `127.0.0.1:8976`, verifies OAuth state, and rejects a changed hostname, port, or path. A dynamic callback port is not accepted.

## Frozen permission profiles

The client contains the union of both profiles. All common permissions are required. Identity Provider Write is optional, allowing the CLI to request it only for email-code setup.

### Existing company login

- Workers Scripts Write
- Workers Routes Write
- D1 Write
- Workers R2 Storage Write
- Workers R2 Storage Bucket Item Write
- Zone Read
- Access: Apps and Policies Write
- Access: Organizations Read
- Access: Identity Providers Read
- Memberships Read
- User Details Read

Cloudflare's permission picker currently contains two similarly named Access rows. This profile uses the account-level `access.write` scope shown as **Access → Edit**, because ArtifactPass creates account-level Access applications. It does not use the zone-level `zone-access.write` scope shown as **Access: Apps and Policies → Edit**.

This profile must not receive Identity Provider Write. The live qualification verifies that an OTP creation request is denied.

### Email verification code

The email-code profile requests every common permission plus:

- Access: Identity Providers Write
- OAuth `offline_access`

The write permission is used only to create or reuse Cloudflare's One-time PIN provider after the administrator approves the deployment plan. `offline_access` lets the CLI refresh its short-lived access token during a long or resumed deployment without asking the administrator to authorize the same run again.

## What the live runner proves

`pnpm test:cloudflare-oauth-qualification` checks the frozen contract, loopback restrictions, report redaction, and hard no-go behavior locally.

`scripts/qualify-cloudflare-oauth.mjs` then performs the live staging qualification. It:

1. Authorizes the company-login profile through Authorization Code with PKCE.
2. Proves that the granted scope set is exact and OTP creation is denied.
3. Revokes the grant and proves that its access token no longer works.
4. Authorizes the email-code profile and refreshes its access token.
5. Binds the run to the selected Cloudflare account and active `artifactpass.com` zone.
6. Creates isolated, disposable D1, R2, Worker, route, Access application, Access policy, and OTP resources with a random qualification suffix.
7. Uses the OAuth bearer with Wrangler for D1 migrations, R2 lifecycle setup, exact-byte R2 sentinel put/get/delete, secret upload, Worker deployment, readiness, and rollback deployment.
8. Deletes every disposable resource and revokes the OAuth grant.
9. Writes a redacted go/no-go record under `docs/releases/`.

The runner never changes Cloudflare billing, plans, payment methods, the ArtifactPass apex, the public Worker, production D1 or R2 resources, or production Access applications. It does not store an access token, refresh token, authorization code, code verifier, client secret, or disposable Worker secret.

## Operator command

The OAuth client ID is not secret, but it is kept out of the committed qualification record. From the repository root:

```sh
pnpm test:cloudflare-oauth-qualification
node scripts/qualify-cloudflare-oauth.mjs \
  --client-id "$CLOUDFLARE_OAUTH_CLIENT_ID" \
  --zone-name artifactpass.com
```

If the Cloudflare account has more than one account membership, add `--account-name` with the exact account name shown by Cloudflare.

The runner opens two Cloudflare consent screens: one for the read-only identity-provider profile and one for the email-code profile. No resource mutation starts before the second profile is authorized and its exact scopes are verified.

## Decision rule

The result is **go** only when every required operation passes, all frozen scope IDs exist in Cloudflare's live catalog, all disposable resources are removed, and both grants are revoked. A missing, skipped, blocked, or failed required operation is **no-go**.

U1 through U8 may begin only after a reviewed redacted live record says `go`.
