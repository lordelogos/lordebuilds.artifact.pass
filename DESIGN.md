# ArtifactPass Design System

This document is the visual and interaction contract for ArtifactPass. It records the decisions approved on the public landing page and authentication popup, then extends them to the sharing flow and artifact viewers.

The goal is not to make every page identical. The goal is to make every page unmistakably part of the same product.

## 1. Product experience

ArtifactPass passes exact work between agents and people through temporary links.

Every public surface must communicate four things quickly:

1. ArtifactPass is built for developers and agentic teams.
2. The core product is the Skill and MCP integration.
3. One file produces one expiring URL.
4. The original artifact remains exact and access is temporary.

The interface should feel precise, calm, technical, and trustworthy. It should not feel like a generic SaaS dashboard, a marketing template, or an abstract AI product.

## 2. Core design principles

### Action before explanation

The primary user action appears early and is unmistakable. On the landing page this is setup. In the sharing flow it is selecting and publishing one document. In a viewer it is reading the artifact.

Supporting explanation stays short. Detailed product education belongs in documentation, not above the primary action.

### One dominant task per surface

Each page has one job:

- Landing page: set up ArtifactPass or try one document.
- Sign-in popup: choose an identity provider and return to the original flow.
- Share page: select, confirm, and publish one document.
- Viewer: read or download one shared artifact.

Secondary actions must not compete with the primary task.

### Exactness is visible

The interface uses real product objects such as filenames, MCP tool names, expiry times, agent roles, and link states. Avoid decorative diagrams that do not explain the real workflow.

Use monospace type for machine-readable information:

- Commands
- Filenames
- Tool names
- URLs
- Format labels
- Expiry traces
- Technical status metadata

### Temporary access is explicit

Expiry is never hidden in fine print. Users should understand the cutoff before publishing and while viewing.

Use concrete durations such as `15 min`, `30 min`, and `60 min`. When a link is live, show the exact cutoff.

### Quiet trust signals

Security and infrastructure are important, but they should support the task instead of interrupting it. Prefer short factual statements:

- Cloudflare Workers, R2, and D1
- Authentication required to create a link
- Exact source retained
- Temporary bearer link
- No history or recovery after expiry

Do not use fear-based copy or oversized security claims.

### Plain-language explanation

The homepage includes a compact `How ArtifactPass works` section below the primary product demonstration. It explains the product to people who do not already know what an MCP or agent handoff is:

- Pick one Markdown, HTML, or PDF file.
- Pick a 15, 30, or 60 minute lifetime.
- Send the temporary link. Opening it requires no account.
- An AI agent can share the file and another agent can open the exact source without copy-pasting or losing formatting.

Keep this section to two balanced columns on desktop and one column on small screens. Its desktop bullet marks are decorative structure, not required meaning, and disappear below `680px` because the column division already supplies hierarchy.

## 3. Composition and layout

### Page frame

- Maximum content width: `1240px`
- Desktop horizontal gutter: `20px` minimum, scaling with the viewport
- Mobile horizontal gutter: `14px`
- Main navigation height: `76px` desktop, `68px` mobile
- The navigation and footer align to the same page frame as the content.

### Desktop balance

Do not leave a large unexplained empty region beside a visually heavy block.

When two pieces of content are related and both are important, compose them as a deliberate two-column layout. The landing hero pairs setup copy with the handoff demonstration. The share page may pair concise context with the document controls.

When a page has only one dominant object, center the object within the frame or let it occupy the useful width. Do not left-align a narrow column and leave the rest of the desktop blank.

### Responsive behavior

- Desktop compositions may use two columns.
- Below `980px`, complex two-column hero compositions become one column.
- Below `680px`, labels in compact navigation actions become visually hidden while icons remain.
- Controls must remain at least `32px` high in compact navigation and at least `44px` high for primary form actions.
- Never preserve desktop whitespace at the cost of mobile readability.

## 4. Color and themes

ArtifactPass supports complete dark and light themes. Theme support is not limited to the landing page. The navbar, popup, sharing flow, viewers, expired state, focus styles, code blocks, and status messages must all follow the selected theme.

### Dark theme

| Token | Value | Use |
| --- | --- | --- |
| `--void` | `#0b0c0e` | Page background |
| `--graphite` | `#121418` | Main panels and dialogs |
| `--bone` | `#efefec` | Primary text |
| `--ash` | `#b8babd` | Secondary text |
| `--slate` | `#797d82` | Tertiary metadata |
| `--white` | `#f9f9f7` | High-contrast action surface |
| `--ink` | `#17181a` | Text on high-contrast light surfaces |
| `--line` | `rgba(255,255,255,.13)` | Default borders and dividers |
| `--line-strong` | `rgba(255,255,255,.22)` | Interactive and emphasized borders |

### Light theme

| Token | Value | Use |
| --- | --- | --- |
| `--void` | `#f3f3f0` | Page background |
| `--graphite` | `#fafaf8` | Main panels and dialogs |
| `--bone` | `#1b1c1e` | Primary text |
| `--ash` | `#4f5358` | Secondary text |
| `--slate` | `#696e74` | Tertiary metadata |
| `--white` | `#111214` | High-contrast action surface |
| `--ink` | `#f8f8f5` | Text on high-contrast dark surfaces |
| `--line` | `rgba(23,24,26,.13)` | Default borders and dividers |
| `--line-strong` | `rgba(23,24,26,.23)` | Interactive and emphasized borders |

### Accent use

The warm, violet, and blue accent colors are reserved for small workflow signals and subtle environmental depth:

- `--amber: #b98458`
- `--violet: #716de4`
- `--blue: #557fbd`

Use them in short gradient rules, relay lines, restrained panel washes, and progress indicators. Do not turn them into broad decorative backgrounds or multicolored buttons.

## 5. Typography

### Interface type

Use:

```css
"Avenir Next", Avenir, "Helvetica Neue", Helvetica, sans-serif
```

The approved system is sans-serif. Do not introduce a serif display typeface on another public page.

### Technical type

Use:

```css
"SFMono-Regular", Consolas, "Liberation Mono", monospace
```

### Hierarchy

- Primary marketing heading: medium weight, tight tracking around `-.055em`, line height close to `1`.
- Product page heading: medium weight with the same family and tracking, scaled to the task.
- Body copy: `14px` to `18px` depending on prominence, with generous line height.
- Labels and metadata: `10px` to `12px`, never smaller than `10px` for meaningful information.
- Monospace metadata should be concise. Do not write paragraphs in monospace.

## 6. Shape, borders, and depth

ArtifactPass uses restrained geometry with clear hierarchy.

### Radii

- Compact controls: `8px` to `11px`
- File and command cards: `10px` to `14px`
- Standard panels: `18px` to `22px`
- Large demonstration stages: up to `34px`

Do not make every element a pill. Pills are reserved for a genuinely compact state label. Navigation, buttons, cards, provider actions, and file controls use rounded rectangles.

### Borders

Thin borders define structure. Most surfaces use a `1px` tokenized border rather than a shadow.

Use dashed borders only for an unresolved drop target. Once a document is selected, the surface becomes a solid file card. This visually closes the selection state and prevents the interface from suggesting multiple uploads.

### Shadows and translucency

- Use shadows for elevated dialogs and authentication cards.
- Use subtle translucency only when it helps show layering.
- Do not stack strong shadows, glows, and gradients on the same component.
- Respect `prefers-reduced-transparency` where backdrop filters are used.

## 7. Navigation

The public navigation is compact and product-like.

- ArtifactPass brand on the left.
- GitHub, theme switch, and setup on the right.
- Thin vertical dividers separate the actions.
- GitHub and setup include text on desktop and become icon-only on smaller screens.
- The theme control always remains a switch-style icon control, never a text button.
- Setup is the only filled navigation action.

Do not add navigation links that have no immediate purpose. Product documentation may be linked when real documentation exists, but empty or redundant links should not occupy the primary navigation.

## 8. Iconography

Icons are functional, consistent, and sourced from one canonical implementation.

- GitHub uses the same shadcn GitHub SVG everywhere.
- Google uses the shadcn Google SVG on every authentication surface.
- The theme switch uses the approved shadcn mode symbol.
- Setup uses the Hugeicons `PlusSignIcon`.
- Provider names must never be represented by placeholder text such as `G` or `GH`.
- Do not hand-draw a replacement when an approved source already exists.
- Shared icons belong in the shared brand icon component, not copied into individual pages.

Icon-only controls require an accessible name and a visible tooltip through `title` where appropriate.

## 9. Controls

### Primary action

- High contrast against the current theme.
- Rounded rectangle, not a pill.
- Minimum height `44px` in forms.
- Label describes the result: `Create temporary link`, not `Submit`.
- Disabled states remain legible and clearly inactive.

### Secondary action

Use a bordered or transparent control with the same geometry. It must remain quieter than the primary action.

### Command control

A command is presented as a technical object:

- Monospace command text
- One contained row
- Copy action separated by a vertical rule
- Confirmation changes the button label temporarily

### Theme switch

The theme control is a compact switch-like icon button. It must never appear as a `Dark` or `Light` text link in the navigation.

### Focus

All links, buttons, form controls, drop targets, and iframe-adjacent controls require visible keyboard focus. Focus rings use the highest contrast theme token and remain outside the component border.

## 10. File selection and sharing flow

ArtifactPass handles one file at a time.

### Empty state

- Dashed drop boundary
- Direct instruction to drop or choose one document
- Supported formats visible nearby
- No implication that multiple files are accepted

### Selected state

Once selected, replace the empty drop zone with a compact solid file card showing:

- Format mark
- Filename
- Size
- `Replace document` action

Do not leave the empty drop instruction visible beside or above a selected file.

### Authentication handoff

- The original page remains open.
- Sign-in opens in a popup.
- The selected file remains local to the browser until authentication completes and the user confirms publishing.
- Closing the popup preserves the selected document and explains what happened.
- Authentication theme follows the parent page theme.

### Configuration

Expiry is selected before publishing. The public service exposes `15 min`, `30 min`, and `60 min`.

### Publishing states

The interface must distinguish:

1. Validating the file
2. Uploading the file
3. Link created
4. Upload failed

Do not hide a failure behind a generic reset. Preserve enough state for the user to correct or retry.

### Success

After publishing:

- The file picker disappears.
- The share URL becomes the dominant object.
- Copying the URL gives immediate confirmation.
- The exact expiry cutoff is shown.
- A quieter `Share another document` action resets the flow.

## 11. Authentication popup

The popup is a focused extension of the initiating page.

- It uses the current light or dark theme.
- The card is centered within the popup viewport.
- Copy explains that the original document remains in the original tab.
- Google and GitHub use their proper icons.
- Provider buttons share the same size and geometry.
- No Cloudflare account language appears in the user authentication flow.
- Completion returns control to the original page.

## 12. Artifact viewers

The shared artifact is the page, not a card inside a marketing page.

### Viewer hierarchy

1. ArtifactPass identity and temporary-link status
2. Filename
3. Format, byte size, source trust, and cutoff
4. The artifact itself
5. Exact-file download

Metadata is useful but must not push the artifact below an oversized hero.

### Markdown

- Comfortable reading width around `760px` to `820px`
- Clear sans-serif heading hierarchy
- Body text optimized for long-form reading
- Monospace code with theme-aware contrast
- Tables remain horizontally scrollable on small screens
- Images and long URLs must not overflow

### HTML

- A neutralized preview copy stays inside a sandboxed iframe with no permissions.
- Scripts, executable embeds, navigation attributes, refreshes, form submission, and external resources are removed or disabled in the preview copy.
- Inline layout and styling may remain when they do not create an external request.
- JavaScript is always disabled on first load. It never runs merely because the uploaded file contains it.
- When the source contains JavaScript, show one compact, flat banner above the artifact. Use a small `JS` badge, the literal title `This file contains JavaScript`, and no explanatory subtext or gradient.
- The inactive action says `Enable JavaScript`; the active action says `Disable JavaScript`. Only the active `JS` badge uses the success color.
- Enabling JavaScript replaces the neutralized frame with a new opaque-origin frame using `sandbox="allow-scripts"`. Never grant `allow-same-origin`, top navigation, forms, popups, downloads, or storage permissions.
- The interactive response applies a second CSP boundary that denies connections, child frames, forms, objects, and non-inline resources. ArtifactPass controls always remain outside the frame.
- Do not call the state an “interactive preview” or add redundant enabled/disabled status copy. Do not claim absolute browser or network isolation.
- `Preview` and `Source` remain available while JavaScript is enabled. Switching views preserves the running frame.
- Disabling JavaScript destroys the interactive frame and creates a fresh neutralized frame. This resets all running state.
- `Source` and `Download` expose the untouched original. Never rewrite the durable artifact to make the preview safe.
- The frame receives the largest practical viewport.
- The surrounding frame follows the ArtifactPass theme without altering the artifact itself.

### PDF

- The PDF frame receives the largest practical viewport.
- Trust status remains visible outside the frame.
- Human-only PDFs must say that agent verification is unavailable without making the document feel broken.

### Expiry

When the cutoff is reached, replace the artifact with a clear expired state. Keep the ArtifactPass visual system and explain that no history or recovery screen exists.

## 13. Content rules

- Prefer short, literal copy.
- Use real product nouns: artifact, file, link, expiry, agent, source.
- Avoid generic AI marketing language.
- Avoid explaining implementation details before the user understands the action.
- Use `ArtifactPass`, never `Artifact Pass`.
- Use `Skill` and `MCP` when describing the installed integration.
- Use `public deployment` and `private deployment` in setup language. Do not use `organization deployment` as the product category.

## 14. Accessibility and interaction quality

- Semantic headings follow a logical order.
- Every icon-only action has an accessible name.
- Every form field has a visible label.
- Status changes use an appropriate live region.
- Error messages explain the next useful action.
- Keyboard users can select files, choose expiry, authenticate, copy, download, and reset.
- Color is never the only indication of state.
- Support `prefers-reduced-motion` and `prefers-reduced-transparency`.
- Iframes have descriptive titles.

## 15. Implementation contract

### Shared primitives

The following should be centralized and reused:

- Theme tokens
- Theme bootstrap and toggle behavior
- Brand mark
- GitHub and Google icons
- Public navigation
- Page frame
- Primary and secondary buttons
- File card
- Status and metadata rows

Do not copy an SVG or recreate a control in a route when a shared primitive exists.

### Theme persistence

- Read an explicit `theme` query parameter when supplied.
- Otherwise use the stored `artifactpass-theme` preference.
- Default to dark when neither exists.
- Update `meta[name="theme-color"]` when the theme changes.
- Propagate the active theme into popup and related-flow URLs.

### Validation before review

Before presenting a UI change:

1. Inspect the actual rendered page at desktop and mobile sizes.
2. Inspect both dark and light themes.
3. Test the primary interaction through its meaningful states.
4. Confirm icon sources and sizes are consistent across surfaces.
5. Confirm no selected-file state still looks like an empty drop target.
6. Run focused component or route tests, typecheck, lint, and the production build.

## 16. Review checklist

Use this checklist for every public UI change:

- Is the primary action obvious without reading a paragraph?
- Does the page have one dominant task?
- Is the desktop composition balanced?
- Does the mobile layout remove unnecessary labels and whitespace?
- Do dark and light themes both feel intentional?
- Are all icons canonical and shared?
- Are buttons rounded rectangles rather than arbitrary pills?
- Is temporary access visible at the decision point?
- Does selected-file UI replace empty-state UI?
- Does every state explain the next action?
- Does the surface feel like ArtifactPass rather than a separate mini-site?
