---
title: Repository-Backed Setup Guides - Plan
type: docs
date: 2026-09-27
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Repository-Backed Setup Guides - Plan

## Goal Capsule

- **Objective:** People can complete normal ArtifactPass setup, administer a private deployment, or join one as a teammate from accurate public guides that are easy to find and update through ordinary repository pull requests.
- **Means:** Render the guides as static public pages from the ArtifactPass repository and include them in the existing navigation, sitemap, structured data, and Cloudflare Pages build (KTD1, KTD2).
- **Authority:** The content hierarchy and decisions recorded in this plan come from the user-approved setup-guide prototype. Current CLI behavior and repository tests define technical accuracy. The existing public-site design system governs visual implementation, and repository release rules govern shipping.
- **Execution profile:** Implement and release the three setup paths through the RC-first workflow.
- **Stop conditions:** Stop if implementation reveals that a documented command or configuration choice does not exist in the current CLI, or if the static Pages deployment cannot serve the guide routes without changing private-deployment behavior.

---

## Product Contract

### Summary

Add a public Guides entry point and three detailed, repository-owned guides: normal agent setup, private deployment administration, and private-deployment teammate setup.

### Problem Frame

The current setup knowledge is split between CLI prompts, terse repository text, and a local prototype. A person evaluating or installing ArtifactPass cannot reliably understand the whole path before beginning, and future corrections are not yet represented as normal product PRs.

### Requirements

**Repository ownership and discovery**

- R1. Guide source, illustrations, route metadata, and tests must live in this repository so future changes are ordinary reviewable PRs.
- R2. The public site must expose a clear `/guides` entry point from global navigation. `/for-ai-agents` must link to `/guides/agent-setup`; `/private-deployments` must link to both `/guides/private-deployment` and `/guides/private-teammate`; the administrator guide must hand off to the teammate guide; and the teammate guide must link administrators back to the administrator guide.
- R3. The Guides hub and every guide must be emitted by the existing static public-site build, included in the sitemap and `llms.txt`, and use canonical metadata appropriate to `artifactpass.com`.

**Guide content**

- R4. The normal setup guide must cover project scope, the complete supported-agent choice, public versus private deployment selection, restart, first-use connection, and a test share.
- R5. The private administrator guide must explain Cloudflare authorization, connecting rather than transferring a domain, DNS and nameserver activation, both publisher-access models, administrator inclusion, sign-in options, all supported link lifetimes, final review actions, deployment progress, later configuration edits, and update behavior.
- R6. The teammate guide must cover the conditional administrator prerequisite, project-local install command, client selection, restart, Cloudflare Access sign-in, and browser plus agent verification. Email-code deployments require the teammate address or domain to be allowed; company-login deployments require an identity provider the teammate can use.
- R7. Every terminal command must have a keyboard-accessible copy control with idle, success, reset, and failure-fallback states. Status changes must be announced without moving focus.
- R8. Public examples must use only reserved documentation namespaces such as `example.com`, `example.net`, `artifacts.example.com`, `admin@example.com`, and `teammate@example.net`. Personal or live third-party domains and email addresses must not appear.
- R9. The guides must be detailed enough to explain meaningful branches and later edits rather than merely listing happy-path prompts.

### Key Decisions

- **Repository-rendered guides.** (session-settled: user-directed — chosen over external or standalone guide files: future edits need to ship through direct repository PRs.) Governs R1, R3.
- **Three distinct setup paths.** (session-settled: user-directed — chosen over one combined private-deployment page: administrators and teammates need different instructions.) Governs R4, R5, R6.
- **Anonymous documentation examples.** (session-settled: user-directed — chosen over the Lorde Builds deployment details: public docs must not expose personal account information.) Governs R8.
- **Detailed branches and editability.** (session-settled: user-directed — chosen over abbreviated setup prose: configuration choices are the product knowledge people need.) Governs R5, R9.

### Acceptance Examples

- AE1. Covers R2, R3. A visitor chooses Guides in the public navigation, lands on `/guides`, and can open each of the three static guide routes without hitting the application Worker.
- AE2. Covers R5, R9. An administrator can read the private deployment guide and understand every lifetime choice and every final-review edit action before running the CLI.
- AE3. Covers R6. A teammate receives `https://artifacts.example.com`, follows the teammate guide, and understands that the administrator must allow them before they can publish.
- AE4. Covers R7. A keyboard user activates Copy beside a command and gets visible confirmation without selecting the command manually.
- AE5. Covers R8. A repository and built-output scan confirms every public guide domain and email example belongs to an approved reserved documentation namespace.
- AE6. Covers R7. If the Clipboard API rejects, the exact command is selected for manual copying, the control keeps focus, and assistive technology announces the fallback.

### Scope Boundaries

- This release includes the setup Guides hub and the three setup paths only.
- The five later editorial or case-study guides remain separate HTML review prototypes until the user approves their content and design.
- This work does not change CLI questions, Cloudflare permissions, deployment resources, or application authentication.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Render guide pages through `renderStaticPublicPage` and `staticPublicAssets`, matching the current static SEO architecture rather than adding dynamic Worker routes. Supports R1 and R3.
- KTD2. Add `/guides` plus one route per audience: `/guides/agent-setup`, `/guides/private-deployment`, and `/guides/private-teammate`. The hub owns discovery while each guide owns one complete task. Supports R2, R4, R5, and R6.
- KTD3. Keep guide copy as typed React markup in `public-pages.tsx` for this release, with illustrations as repository SVG assets. This matches current public-page ownership and keeps the built pages static. Guide assertions must use the same supported-client and lifetime sources as the CLI where those values are exported. Supports R1.
- KTD4. Export one deterministic guide interaction script for copy controls. Hash that exact script in the static Pages content-security policy and authorize it by nonce only on dynamic render paths. Render it only on pages that contain copy controls. Static content remains available without JavaScript. Supports R7.
- KTD5. Treat screenshots and diagrams as informative when they communicate a required choice, with descriptive alt text and a caption. Decorative imagery must use empty alt text. On narrow screens, commands may scroll horizontally while the copy button remains visible and follows the command in keyboard order. Supports R7 and R9.
- KTD6. Cloudflare Pages is a separate manual deployable named `artifactpass-site`; it has no Git provider. Build `apps/artifact-pages/dist` from the reviewed commit, deploy that exact build to a named preview branch for qualification, then deploy the same source commit from `main` to the Pages production branch after merge. Record the Pages deployment ID and source commit in release evidence.

### Sequencing

Complete the shared route and navigation model first. Finish each audience-specific guide next. Update indexing, static output, and tests after the route set is stable. Then run local browser checks and the repository release sequence.

---

## Implementation Units

### U1. Guides hub, routes, and global discovery

- **Goal:** Establish the public route shells and entry points for all setup documentation.
- **Requirements:** R1, R2, R3.
- **Dependencies:** None.
- **Files:** `apps/artifact-service/src/web/routes/public-pages.tsx`, `apps/artifact-service/src/web/components/public-chrome.tsx`, `apps/artifact-service/src/build/static-public-assets.ts`, `apps/artifact-service/test/public-pages.test.ts`.
- **Approach:** Add route shells for the Guides hub and three audience pages to the existing page union, path/title/description helpers, static build output, navigation, footer, sitemap, `llms.txt`, and structured data. Apply the contextual link matrix in R2.
- **Patterns to follow:** Existing static public routes such as `/how-it-works` and `/private-deployments`.
- **Test scenarios:**
  - Covers AE1. Each route shell renders a canonical static page and appears in static headers, sitemap, and `llms.txt`.
  - The public header and footer link to `/guides` without removing existing setup or GitHub access.
- **Verification:** Targeted public-page tests and a production build contain the four expected guide HTML files.

### U2. Normal agent setup guide

- **Goal:** Publish the complete project-local setup path for any supported MCP client.
- **Requirements:** R4, R7, R8, R9.
- **Dependencies:** U1.
- **Files:** `apps/artifact-service/src/web/routes/public-pages.tsx`, `apps/artifact-service/public/guides/agent-setup/*.svg`, `apps/artifact-service/test/public-pages.test.ts`.
- **Approach:** Adapt the approved prototype into the public design, retain detailed agent and deployment branches, and add copyable commands.
- **Test scenarios:**
  - The guide names all currently supported clients and the generic MCP option.
  - Public and private setup instructions use the correct command and URL format.
  - Covers AE4, AE5, and AE6. Copy controls render accessibly, retain focus through every state, and public output contains only reserved examples.
- **Verification:** Rendered markup assertions plus desktop and mobile browser review.

### U3. Private deployment administrator guide

- **Goal:** Let an administrator understand and complete every private-deployment decision, including later edits.
- **Requirements:** R5, R7, R8, R9.
- **Dependencies:** U1.
- **Files:** `apps/artifact-service/src/web/routes/public-pages.tsx`, `apps/artifact-service/public/guides/private-deployment/*.svg`, `apps/artifact-service/test/public-pages.test.ts`.
- **Approach:** Expand the private guide with domain activation, access-model branches, five lifetime choices, six review actions, progress and success states, and the resume workflow. Replace all personal examples in markup and illustrations.
- **Test scenarios:**
  - Covers AE2. All five lifetimes and all six review actions appear in rendered output.
  - Both publisher models explain administrator inclusion and how to add or remove access later.
  - The guide distinguishes connecting DNS from transferring domain registration.
  - Covers AE5. No personal domain or email survives in source or built assets.
- **Verification:** Rendered-content assertions, SVG text scan, and desktop plus mobile browser review.

### U4. Private deployment teammate guide

- **Goal:** Give invited publishers a focused setup path without making them parse administrator-only Cloudflare deployment work.
- **Requirements:** R6, R7, R8, R9.
- **Dependencies:** U1, U3.
- **Files:** `apps/artifact-service/src/web/routes/public-pages.tsx`, the shared `apps/artifact-service/public/guides/private-deployment/teammate-setup.svg` illustration, and `apps/artifact-service/test/public-pages.test.ts`.
- **Approach:** Extract teammate setup into its own route, link it from the administrator success section, and state the publisher-access prerequisite for both email-code and company-login deployments.
- **Test scenarios:**
  - Covers AE3. The page clearly states what the admin must do first for each sign-in model and what the teammate does in their project.
  - The private base URL command uses `https://artifacts.example.com` and has a working copy control.
  - Browser and agent verification remain separate and explicit.
- **Verification:** Rendered-content assertions and browser review at desktop and mobile widths.

### U5. Static interaction, regression coverage, and release proof

- **Goal:** Prove the documentation is static, accessible, indexable, and safe to promote.
- **Requirements:** R3, R7, R8.
- **Dependencies:** U1, U2, U3, U4.
- **Files:** `apps/artifact-service/src/web/routes/public-pages.tsx`, `apps/artifact-service/src/build/static-public-assets.ts`, `apps/artifact-service/test/public-pages.test.ts`, `tests/e2e/public-pages.spec.ts` if browser coverage needs a new focused case.
- **Approach:** Add the copy interaction script under the current CSP, assert canonical and robots behavior, scan generated assets for personal examples, and exercise route navigation and copy feedback in a browser.
- **Test scenarios:**
  - Covers AE1. Static build outputs resolve every clean guide URL and each finished page contains its full audience-specific content.
  - Covers AE4 and AE6. Keyboard activation copies the exact command, updates and resets the control label, announces status, and provides a selection fallback when Clipboard access fails.
  - Covers AE5. Source and build scans accept only the approved reserved example namespaces.
  - Existing public pages, upload navigation, theme control, and private deployment output remain unchanged.
- **Verification:** Affected-package tests, typecheck, both application and Pages builds, browser suite, repository check, release check, RC workflow qualification, Pages preview qualification, stable promotion when a package version changes, Pages production deployment, and production smoke.

---

## Verification Contract

| Gate | Applies to | Done signal |
|---|---|---|
| `pnpm --dir apps/artifact-service test` | U1-U5 | Public-page and service tests pass. |
| `pnpm --dir apps/artifact-service typecheck` | U1-U5 | Guide route and component types compile without errors. |
| `pnpm --dir apps/artifact-service build` | U1-U5 | The application Worker still builds with the shared public-page renderers. |
| `pnpm --dir apps/artifact-pages build` | U1-U5 | `apps/artifact-pages/dist` contains the Guides hub and three guide pages with their assets and generated security headers. |
| `pnpm test:browser` | U2-U5 | Public navigation, responsive layouts, and copy controls work in a real browser. |
| `pnpm check` | Entire change | Repository lint, typechecks, tests, generated plugin checks, and builds pass. |
| `pnpm release:check` | Release candidate | Secret, distribution, license, audit, build, and package inspection gates pass. |
| Exact RC workflow qualification | Release | Documented CLI commands are executed against the exact RC when package behavior changed; guide-only releases prove the unchanged current `latest` command still matches the rendered guide. |
| Cloudflare Pages preview | Release | The build from the reviewed commit is deployed to a named non-production branch of `artifactpass-site`; all guide routes, CSP copy behavior, and existing app routes pass there. |
| Production smoke | Release | The merged `main` commit is deployed to the Pages production branch, its deployment ID is recorded, and `artifactpass.com/guides` plus all three guides are live, canonical, indexable, and linked from the public site. The unpinned `artifactpass@latest` workflow is rechecked after any npm promotion. |

---

## Definition of Done

- The repository contains the canonical source and illustrations for the Guides hub and all three setup paths.
- The static build, sitemap, structured data, `llms.txt`, header, footer, and relevant product pages expose the guides.
- Commands are copyable and the pages remain readable without JavaScript.
- Public guide source and generated assets use only reserved documentation domains and email examples.
- The approved content is merged to `main`, released through a qualified RC, promoted to npm `latest` when the package version changes, and deployed to production.
- Abandoned prototype-only or duplicate route code is not left in the release diff.
