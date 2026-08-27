# Hosted activation status

The earlier private activation used Cloudflare Access to restrict `artifactpass.com` to named testers. That setup proved the Worker, D1, R2, device flow, share links, expiry, and cleanup, but it is not the public product flow.

Public activation now follows [deployment](deployment.md). The release deploys ArtifactPass-owned Google and GitHub sign-in, verifies both providers and the protected upload redirect, then removes only the matching legacy Access application. Public users never sign in to Cloudflare.

The compatibility resource names remain unchanged during this transition:

- Worker: `lordebuilds-artifacts-share`
- D1 database: `lordebuilds-artifacts-share`
- R2 bucket: `lordebuilds-artifacts-share`
- D1 binding: `ARTIFACT_DB`
- R2 binding: `ARTIFACTS`

This preserves stored artifacts, migration history, routes, and signed PDF provenance while changing only the human authentication boundary and the public expiry policy.
