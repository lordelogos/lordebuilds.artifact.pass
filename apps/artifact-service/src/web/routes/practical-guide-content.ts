export const privateCloudflareContent = `<div class="summary">
          <strong>The question</strong>
          <p>A private deployment changes where ArtifactPass runs and who may publish. It does not change the basic temporary-link model.</p>
        </div>

        <section id="ownership">
          <h2>Keep the application and its data in your Cloudflare account</h2>
          <p>A private deployment places the sharing application on your hostname and creates the infrastructure inside your Cloudflare account.</p>

          <div class="facts" aria-label="Private deployment resources">
            <div class="fact"><strong>Worker</strong><span>Handles publishing, authentication, artifact viewing, and expiry work.</span></div>
            <div class="fact"><strong>R2</strong><span>Stores the shared file bytes in a private bucket owned by the operator.</span></div>
            <div class="fact"><strong>D1</strong><span>Stores temporary metadata, access state, and deletion records.</span></div>
            <div class="fact"><strong>Cloudflare Access</strong><span>Controls which people may publish through the private deployment.</span></div>
          </div>

          <p>The public ArtifactPass landing page, policies, and general guides remain on <code>artifactpass.com</code>. Your hostname receives the actual sharing application and viewer, not a copy of the marketing site.</p>
        </section>

        <section id="access">
          <h2>Separate publisher access from link access</h2>
          <p>Cloudflare Access protects publishing. The administrator can approve company email domains or specific email addresses. People outside those rules cannot sign in to publish.</p>
          <p>Reading uses a different model. Each live artifact URL is a temporary bearer link. Anyone holding that URL can open the artifact until it expires, without joining the publisher allow list.</p>

          <div class="comparison">
            <table>
              <thead><tr><th>Action</th><th>Who may do it</th><th>Control</th></tr></thead>
              <tbody>
                <tr><td>Publish an artifact</td><td>Approved people</td><td>Cloudflare Access policy</td></tr>
                <tr><td>Open a live artifact</td><td>Anyone holding its URL</td><td>Temporary bearer link</td></tr>
                <tr><td>Change the deployment</td><td>The Cloudflare account operator</td><td>Cloudflare account and deployment receipt</td></tr>
              </tbody>
            </table>
          </div>

          <figure class="figure">
            <div class="figure-frame">
              <img src="../../../apps/artifact-service/public/guides/private-deployment/cloudflare-access-application.png" alt="Cloudflare Access applications page showing an ArtifactPass application and publisher policy" width="1735" height="907">
            </div>
            <figcaption>The Access application protects the private hostname's publishing routes. Artifact links keep their own temporary read access.</figcaption>
          </figure>

          <p>ArtifactPass does not send invitation emails. Administrators share the private hostname with approved teammates after adding them to the policy.</p>
        </section>

        <section id="updates">
          <h2>Private deployments update deliberately</h2>
          <p>A deployment stays on the ArtifactPass version that created it. Publishing a new package does not silently change the Worker running in another Cloudflare account.</p>
          <p>When the operator chooses to update, ArtifactPass reuses the existing hostname, Access application, D1 database, R2 bucket, and stored artifacts. Updates remain deliberate and version-pinned.</p>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/upload-selected-html.png" alt="ArtifactPass private upload page with an HTML file selected and a one day lifetime chosen" width="1440" height="900">
            </div>
            <figcaption>The private hostname serves the focused sharing application while its data remains in the operator's Cloudflare account.</figcaption>
          </figure>
        </section>

        <section id="fit">
          <h2>Use a private deployment when infrastructure ownership matters</h2>
          <p>Private ArtifactPass is a good fit when a team wants its own domain, Cloudflare account, storage, metadata, publisher policy, and controlled update schedule.</p>
          <p>The hosted public service is the simpler choice when the team only needs temporary sharing and does not need to own the underlying Cloudflare resources.</p>

          <div class="comparison">
            <table>
              <thead><tr><th>Need</th><th>Best starting point</th></tr></thead>
              <tbody>
                <tr><td>Share one temporary file quickly</td><td>Public ArtifactPass</td></tr>
                <tr><td>Keep storage and metadata in your Cloudflare account</td><td>Private deployment</td></tr>
                <tr><td>Restrict who may publish using company login rules</td><td>Private deployment</td></tr>
                <tr><td>Restrict every reader to an individual account</td><td>Use a system with per-reader authorization</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="next">
          <h2>Deploy or invite teammates</h2>
          <p>Follow the <a href="/guides/private-deployment">private deployment guide</a> for the domain, DNS, sign-in, publisher rules, lifetimes, review, deployment, and update flow.</p>
          <p>After deployment, send teammates the <a href="/guides/private-teammate">private teammate guide</a>.</p>
        </section>

        <section class="faq" id="faq">
          <h2>Common questions</h2>
          <details>
            <summary>Does a private deployment copy the ArtifactPass marketing site?</summary>
            <p>No. It deploys the sharing application and viewer. Public pages and policies remain on artifactpass.com.</p>
          </details>
          <details>
            <summary>Does every reader need to be on the publisher allow list?</summary>
            <p>No. The allow list controls publishing. A live artifact URL remains readable by anyone holding it until expiry.</p>
          </details>
          <details>
            <summary>Do private deployments update automatically?</summary>
            <p>No. The operator chooses when to run the update flow.</p>
          </details>
        </section>`;

export const javascriptPreviewContent = `<div class="summary">
          <strong>The problem</strong>
          <p>An HTML file may contain code. Opening a share link should not run that JavaScript before the recipient chooses to enable it.</p>
        </div>

        <section id="default">
          <h2>JavaScript stays off until the recipient enables it</h2>
          <p>ArtifactPass opens the preview with JavaScript disabled and labels files that contain it. The recipient can read the static preview, inspect Source, download the exact file, or choose Enable JavaScript.</p>

          <figure class="figure">
            <div class="figure-frame figure-frame--viewer-controls">
              <img src="assets/viewer-javascript-disabled-mobile.png" alt="ArtifactPass HTML viewer with JavaScript disabled and an Enable button" width="390" height="260">
            </div>
            <figcaption>The initial state identifies JavaScript and leaves the decision with the recipient.</figcaption>
          </figure>

          <div class="facts" aria-label="Viewer states">
            <div class="fact"><strong>Preview</strong><span>Shows a neutralized browser rendering with uploaded scripts removed.</span></div>
            <div class="fact"><strong>Enable JavaScript</strong><span>Starts an isolated frame for the demo's client-side behavior.</span></div>
            <div class="fact"><strong>Source</strong><span>Displays the exact uploaded HTML as text for review.</span></div>
            <div class="fact"><strong>Download</strong><span>Returns the original bytes without rewriting the durable artifact.</span></div>
          </div>
        </section>

        <section id="enabled">
          <h2>What enabling JavaScript actually does</h2>
          <p>The recipient's browser performs the computation. ArtifactPass serves the uploaded HTML as a separate response with restrictive browser headers, and the browser executes allowed client-side behavior inside the preview frame. ArtifactPass does not create a dedicated server process or hosted browser session for the demo.</p>
          <p>That distinction matters. A chart animation or local calculator uses the recipient's CPU and memory. The ArtifactPass infrastructure still serves the artifact and viewer request, but it is not continuously computing the interface on the user's behalf.</p>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/viewer-javascript-enabled.png" alt="ArtifactPass viewer running a fictional project-status demo after JavaScript is enabled" width="1440" height="900">
            </div>
            <figcaption>The same viewer becomes functional after the recipient chooses Enable JavaScript.</figcaption>
          </figure>

          <div class="comparison">
            <table>
              <thead><tr><th>Question</th><th>Answer</th></tr></thead>
              <tbody>
                <tr><td>Where does the JavaScript run?</td><td>Inside the recipient's browser.</td></tr>
                <tr><td>Does ArtifactPass run it on a server?</td><td>No. The server delivers the preview document and artifact data.</td></tr>
                <tr><td>Can it call the public internet?</td><td>No. Network access is blocked in the enabled preview.</td></tr>
                <tr><td>Can it keep running after the tab closes?</td><td>No. Closing or navigating away ends that browser context.</td></tr>
                <tr><td>Can the recipient stop it?</td><td>Yes. Use Disable JavaScript, close the tab, or navigate away from the artifact.</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="isolation">
          <h2>The preview is isolated in layers</h2>
          <p>ArtifactPass does not rely on a single browser flag. It prepares a separate preview representation and combines content removal with browser-enforced boundaries.</p>

          <h3>Neutralized content</h3>
          <p>For the passive preview, scripts and executable embeds are removed. Navigation and external-resource attributes are stripped, refresh metadata is removed, forms and controls are disabled, and external CSS resources are removed.</p>

          <h3>Sandboxed frame</h3>
          <p>The preview runs inside an iframe with no broad permissions. The frame is intentionally separated from the ArtifactPass application page and its authenticated state.</p>

          <h3>Deny-by-default Content Security Policy</h3>
          <p>The preview receives a restrictive Content Security Policy. Network destinations are not opened for the uploaded code, so fetches, analytics, remote scripts, external fonts, and API requests cannot operate as they would on a normal hosted website.</p>

          <h3>Original source remains separate</h3>
          <p>The preview copy is not the durable artifact. Source view and download retain the exact uploaded bytes. This lets ArtifactPass make previewing safer without silently changing the file the creator shared.</p>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/viewer-source.png" alt="ArtifactPass source view showing the exact uploaded HTML" width="1440" height="900">
            </div>
            <figcaption>Source view exposes the exact uploaded HTML even while the preview uses a prepared representation.</figcaption>
          </figure>

          <aside class="note">
            <strong>A browser boundary is still a browser boundary</strong>
            <p>The isolation depends on the browser engine correctly enforcing iframe sandboxing and Content Security Policy. ArtifactPass removes active content first and tests the boundary, but no browser-based system can claim protection from every possible browser-engine vulnerability.</p>
          </aside>
        </section>

        <section id="compute">
          <h2>How many previews can run at once?</h2>
          <p>ArtifactPass does not reserve application compute for each active JavaScript preview. The long-running work happens on each recipient's device, so there is no separate preview-concurrency pool that fills up as more people enable JavaScript.</p>
          <p>Infrastructure usage still grows with normal traffic. Each viewer load reads metadata and artifact content through the Worker and storage layer. Bandwidth, Worker requests, D1 reads, and R2 operations are the relevant service limits. The animation loop or local interaction itself is not billed as server compute after the browser receives it.</p>
          <p>A very large or computationally expensive script can still make the recipient's tab slow. The browser may throttle it, display an unresponsive-page warning, or terminate the tab. That cost lands on the viewer's device, which is another reason not to enable code from an untrusted source.</p>
        </section>

        <section id="decide">
          <h2>When should a recipient enable it?</h2>
          <p>Enable JavaScript when the sender is trusted and the interaction is necessary to review the artifact. A chart with filters, a small prototype, or a local calculator may need it. A static report often does not.</p>
          <p>Before enabling, check the filename, sender, source, and purpose. If the artifact arrived unexpectedly, leave JavaScript disabled. If the source references remote services or secrets, do not assume the preview will make that design safe or functional.</p>

          <h3>For creators</h3>
          <ul>
            <li>Keep the demo self-contained and avoid external dependencies.</li>
            <li>Explain what the interaction is expected to do.</li>
            <li>Use synthetic or non-sensitive sample data.</li>
            <li>Test the file without network access before sharing it.</li>
            <li>Choose the shortest lifetime that gives the reviewer enough time.</li>
          </ul>

          <h3>For recipients</h3>
          <ul>
            <li>Leave JavaScript disabled when the static preview is enough.</li>
            <li>Inspect Source before running code from a sender you do not know well.</li>
            <li>Disable JavaScript or close the tab if the page behaves unexpectedly.</li>
            <li>Remember that downloading and opening the file elsewhere leaves the ArtifactPass preview boundary.</li>
          </ul>
        </section>

        <section class="faq" id="faq">
          <h2>Common questions</h2>
          <details>
            <summary>Why not run JavaScript automatically?</summary>
            <p>Automatic execution would remove the recipient's choice and make opening a file perform active work without a clear signal.</p>
          </details>
          <details>
            <summary>Why keep Source and Download?</summary>
            <p>They make the handoff verifiable. The recipient can inspect the exact HTML and keep the original file instead of relying only on a transformed preview.</p>
          </details>
          <details>
            <summary>Can the preview access ArtifactPass sign-in cookies?</summary>
            <p>The sandboxed preview is separated from the application context and is not granted broad permissions to the parent page's authenticated state.</p>
          </details>
          <details>
            <summary>Does disabling JavaScript delete the artifact?</summary>
            <p>No. It only stops active code in the preview. The artifact remains available until its selected expiry.</p>
          </details>
        </section>`;

export const agentSharingContent = `<div class="summary">
          <strong>The problem</strong>
          <p>Chat can truncate a finished file, change its formatting, or turn HTML into an escaped code block. The recipient cannot easily verify that they received the original artifact.</p>
        </div>

        <section id="why">
          <h2>Give the finished file a proper handoff</h2>
          <p>ArtifactPass lets the agent publish one completed file and return a temporary link. The recipient sees the filename, file type, size, preview, source when supported, and remaining lifetime.</p>

          <div class="comparison">
            <table>
              <thead><tr><th>Handoff</th><th>What arrives</th><th>Verification</th></tr></thead>
              <tbody>
                <tr><td>Paste into chat</td><td>A message representation</td><td>Hard to prove formatting and bytes stayed intact</td></tr>
                <tr><td>Repository commit</td><td>A durable code change</td><td>Strong history, but too heavy for every review artifact</td></tr>
                <tr><td>ArtifactPass link</td><td>The exact supported file</td><td>Preview, source, metadata, and explicit expiry in one viewer</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="ready">
          <h2>Start from a project that is already connected</h2>
          <p>This guide begins after ArtifactPass is available to the agent. If this project is not connected yet, follow the <a href="/guides/agent-setup">AI agent setup guide</a>, restart the agent session, then return here.</p>
          <p>It covers supported agents, public and private deployments, browser approval, project scope, configuration changes, and installation checks.</p>
        </section>

        <section id="publish">
          <h2>Ask the agent to publish a finished file</h2>
          <p>Name the file and the lifetime. Public ArtifactPass supports 1 hour, 1 day, and 7 days. The agent resolves the file inside the approved workspace, validates the supported type and size, uploads it, then returns the share link.</p>

          <div class="command">
            <code>Share ./report.md for 1 day.</code>
            <button class="copy-button" type="button" data-copy>Copy</button>
          </div>

          <p>Good prompts are simple because the capability is intentionally narrow. Use one file per share. If a draft is still changing, finish it first. The ArtifactPass link is a handoff, not a collaborative editing surface.</p>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/upload-success.png" alt="ArtifactPass confirmation page showing that a temporary link is live" width="1440" height="900">
            </div>
            <figcaption>The finished publish returns one temporary URL with a visible cutoff.</figcaption>
          </figure>
        </section>

        <section id="handoff">
          <h2>Complete a person or agent handoff</h2>
          <h3>Agent to person</h3>
          <p>Open the returned URL in any browser. The recipient does not need an account. Send the link only to the intended reviewers because anyone holding it can open the artifact until it expires.</p>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/viewer-markdown.png" alt="ArtifactPass viewer displaying a shared Markdown release note" width="1440" height="900">
            </div>
            <figcaption>The recipient gets a readable preview, the filename, remaining lifetime, source, and download in one place.</figcaption>
          </figure>

          <h3>Agent to agent</h3>
          <p>Give the ArtifactPass link to another connected agent and ask it to read the artifact. The receiving agent retrieves the supported source instead of reconstructing the document from a pasted response.</p>

          <h3>Person to agent</h3>
          <p>A person can create a link from the browser upload page, then give that URL to a connected agent. This is useful when the file begins outside an agent workspace.</p>

        </section>

        <section id="boundaries">
          <h2>What this workflow does not replace</h2>
          <p>Use Git for durable code history, a drive for permanent storage, and a collaboration tool for ongoing editing. ArtifactPass is for a finished artifact that needs to move cleanly between contexts for a limited time.</p>
          <p>Expiry stops the ArtifactPass URL, but it cannot delete a downloaded copy. Agent access is also separate from link access. Disconnecting an agent stops future publishing; it does not retract a link that is already live.</p>
        </section>

        <section class="faq" id="faq">
          <h2>Common questions</h2>
          <details>
            <summary>Does every recipient need ArtifactPass installed?</summary>
            <p>No. A person can open a live link in a normal browser. Installation is needed only when an agent should publish or read artifacts directly.</p>
          </details>
          <details>
            <summary>What file types are supported?</summary>
            <p>ArtifactPass supports Markdown, HTML, and PDF. The viewer and agent-readable representation depend on the file type and its security checks.</p>
          </details>
        </section>`;

export const interactiveHtmlContent = `<div class="summary">
          <strong>The problem</strong>
          <p>An interactive HTML file is awkward to share. Attachments make people download it, chat can alter it, and deploying a site is too much work for a quick review.</p>
        </div>

        <section id="problem">
          <h2>Share the file, not a new website</h2>
          <p>ArtifactPass turns one HTML file into a temporary browser link. The recipient can preview it, inspect the exact source, download it, and decide whether its JavaScript runs.</p>

          <div class="facts" aria-label="What the handoff includes">
            <div class="fact"><strong>One source file</strong><span>The exact uploaded HTML remains available for source review and download.</span></div>
            <div class="fact"><strong>One browser link</strong><span>The recipient does not need an ArtifactPass account to open a live link.</span></div>
            <div class="fact"><strong>A clear expiry</strong><span>Choose 1 hour, 1 day, or 7 days for the public service.</span></div>
            <div class="fact"><strong>Controlled JavaScript</strong><span>The file opens with JavaScript disabled until the recipient enables it.</span></div>
          </div>
        </section>

        <section id="prepare">
          <h2>Prepare a self-contained HTML file</h2>
          <p>The strongest handoff is a single file that carries its own markup, styles, and scripts. Inline the CSS and JavaScript that belong to the demo. Avoid runtime dependencies on APIs, remote fonts, CDNs, analytics, or external images.</p>
          <p>This is not only about portability. ArtifactPass blocks network access inside the enabled JavaScript preview. A demo that depends on a remote endpoint may still display its static shell, but the network-dependent behavior will not complete.</p>

          <h3>Check the file before publishing</h3>
          <ul>
            <li>Open it locally and confirm the core interaction works without a build server.</li>
            <li>Keep the file at or below the public service limit of 25 MB.</li>
            <li>Remove secrets, tokens, private endpoints, and data that should not leave the project.</li>
            <li>Use embedded sample data when the interaction normally depends on an API.</li>
            <li>Give the file a meaningful name, such as <code>artifactpass-project-pulse-demo.html</code>.</li>
          </ul>

          <aside class="note">
            <strong>Good fit</strong>
            <p>Charts, interface prototypes, data stories, calculators, animation studies, and single-page demos are good candidates. A full application with a backend, login, routing, or live API access should use normal application hosting.</p>
          </aside>
        </section>

        <section id="publish">
          <h2>Publish from the browser or your agent</h2>
          <p>For a one-off share, open the ArtifactPass upload page, choose the HTML file, select its lifetime, and create the temporary link.</p>
          <p>If the file was produced inside an agent workspace, ask the connected agent to publish it. The request can stay natural and specific:</p>

          <div class="command">
            <code>Share ./artifactpass-project-pulse-demo.html for 1 day.</code>
            <button class="copy-button" type="button" data-copy>Copy</button>
          </div>

          <p>The agent uses the ArtifactPass MCP tool to read the approved local file, publish it, and return the temporary HTTPS link. If the project is not connected yet, follow the <a href="/guides/agent-setup">AI agent setup guide</a> first.</p>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/upload-selected-html.png" alt="ArtifactPass upload page with a fictional project-status demo selected and a one day lifetime chosen" width="1440" height="900">
            </div>
            <figcaption>The browser flow confirms the exact file and lifetime before publishing.</figcaption>
          </figure>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/upload-success.png" alt="ArtifactPass confirmation page showing that a temporary link is live" width="1440" height="900">
            </div>
            <figcaption>After publishing, ArtifactPass presents the temporary link and its exact cutoff.</figcaption>
          </figure>
        </section>

        <section id="recipient">
          <h2>What the recipient sees</h2>
          <p>The viewer keeps the important actions close together: the filename, Preview and Source controls, Download, and the JavaScript control when the file contains a script.</p>
          <p>The first preview is passive. JavaScript is disabled, so the recipient can inspect the page before allowing code to run. The banner states that the file contains JavaScript and offers a direct Enable JavaScript action. After enabling it, the same control lets the recipient disable it again.</p>

          <figure class="figure">
            <div class="figure-frame figure-frame--viewer-controls">
              <img src="assets/viewer-javascript-disabled-mobile.png" alt="ArtifactPass HTML viewer with JavaScript disabled and an Enable button" width="390" height="260">
            </div>
            <figcaption>The initial viewer state names the JavaScript clearly and leaves execution off.</figcaption>
          </figure>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/viewer-javascript-enabled.png" alt="ArtifactPass viewer running a fictional project-status demo after JavaScript is enabled" width="1440" height="900">
            </div>
            <figcaption>Once enabled, the prototype behaves normally inside the isolated preview.</figcaption>
          </figure>

          <p>Source remains available during either state. That matters for review because a recipient can compare the rendered result with the exact HTML that produced it. Download returns the original uploaded bytes rather than a rewritten preview copy.</p>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/viewer-source.png" alt="ArtifactPass source view showing the exact uploaded HTML" width="1440" height="900">
            </div>
            <figcaption>Source view stays beside Preview so the rendered behavior can be checked against the uploaded HTML.</figcaption>
          </figure>

          <div class="comparison">
            <table>
              <thead><tr><th>Action</th><th>What it is for</th><th>What runs</th></tr></thead>
              <tbody>
                <tr><td>Preview with JavaScript disabled</td><td>Read the static layout safely</td><td>No uploaded JavaScript</td></tr>
                <tr><td>Enable JavaScript</td><td>Try the intended interaction</td><td>Code inside an isolated browser frame</td></tr>
                <tr><td>Source</td><td>Inspect the exact HTML</td><td>No page script execution</td></tr>
                <tr><td>Download</td><td>Keep the original file</td><td>Nothing until the recipient opens it elsewhere</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="limits">
          <h2>Important limits to explain</h2>
          <p>An ArtifactPass URL is a temporary bearer link. Anyone who receives the live URL can open and redistribute the artifact until it expires. Send it only to the people who should see it.</p>
          <p>Enabling JavaScript does not turn ArtifactPass into a hosted application server. The code runs on the recipient's device, inside the browser preview. ArtifactPass does not allocate a server process for each open demo, and the preview cannot make network requests.</p>
          <p>Expiry stops access through ArtifactPass, but it cannot remove a copy that someone already downloaded. If the work needs durable permissions, revocation, audit history, or a permanent URL, use a system designed for that job.</p>
        </section>

        <section class="faq" id="faq">
          <h2>Common questions</h2>
          <details>
            <summary>Can the preview call an API?</summary>
            <p>No. Network access is blocked inside the enabled JavaScript preview. Embed representative sample data for the review.</p>
          </details>
          <details>
            <summary>Does the recipient need to sign in?</summary>
            <p>No. Only the publisher signs in. Anyone with the live share URL can open the artifact until it expires.</p>
          </details>
          <details>
            <summary>Can an agent read the HTML too?</summary>
            <p>Yes. A connected agent can read a valid ArtifactPass link and inspect the supported source instead of relying on a screenshot or copied chat text.</p>
          </details>
          <details>
            <summary>What if the prototype needs several files?</summary>
            <p>Bundle it into one self-contained HTML file, or use normal application hosting. ArtifactPass publishes one supported artifact per link.</p>
          </details>
        </section>`;

export const temporarySharingContent = `<div class="summary">
          <strong>The problem</strong>
          <p>A file needed for one review often ends up behind a URL that keeps working long after the review is over.</p>
        </div>

        <section id="problem">
          <h2>Set the cutoff when you publish</h2>
          <p>ArtifactPass makes the lifetime part of the publishing step and shows the remaining time in the viewer. When the cutoff arrives, the link stops serving the artifact.</p>
        </section>

        <section id="lifetime">
          <h2>Choose the shortest useful lifetime</h2>
          <p>The public service offers three human-scale choices. Pick based on when the recipient can realistically review the file, not on a vague desire to keep access around just in case.</p>

          <div class="facts" aria-label="Artifact lifetime choices">
            <div class="fact"><strong>1 hour</strong><span>A live call, immediate review, or same-session handoff.</span></div>
            <div class="fact"><strong>1 day</strong><span>An asynchronous review that should be completed today or tomorrow.</span></div>
            <div class="fact"><strong>7 days</strong><span>A wider review window across schedules or time zones.</span></div>
            <div class="fact"><strong>No permanent option</strong><span>ArtifactPass is not a drive, archive, or long-term publishing platform.</span></div>
          </div>

          <p>A private deployment can choose which supported lifetimes appear for its users. The maximum remains 7 days. Administrators can change the offered choices by resuming the deployment and reviewing its configuration.</p>

          <aside class="note">
            <strong>Expiry is not recall</strong>
            <p>Expiry stops the ArtifactPass URL. It cannot remove a file that a recipient already downloaded, copied, or redistributed while the link was live.</p>
          </aside>
        </section>

        <section id="share">
          <h2>Publish from the browser or a connected agent</h2>
          <p>From the browser, choose one supported file, select its lifetime, and create the temporary link. Public ArtifactPass accepts Markdown, HTML, and PDF files up to 25 MB.</p>
          <p>From an agent workspace, name the file and lifetime in the request:</p>

          <div class="command">
            <code>Share ./client-review.pdf for 7 days.</code>
            <button class="copy-button" type="button" data-copy>Copy</button>
          </div>

          <p>The agent publishes from an approved project root and returns the URL. Only the publisher signs in. A recipient can open the live link without an ArtifactPass account.</p>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/upload-selected-markdown.png" alt="ArtifactPass upload page with a Markdown file selected and a one day lifetime chosen" width="1440" height="900">
            </div>
            <figcaption>The publisher chooses the file and cutoff together instead of creating an indefinite link by default.</figcaption>
          </figure>

          <figure class="figure">
            <div class="figure-frame">
              <img src="assets/viewer-markdown.png" alt="ArtifactPass viewer displaying a shared Markdown release note with its remaining lifetime" width="1440" height="900">
            </div>
            <figcaption>While the link is live, the viewer keeps the filename, remaining lifetime, source, and download visible.</figcaption>
          </figure>

          <h3>Treat the URL as the read credential</h3>
          <p>The share token is carried in the URL. Anyone holding that URL can read and download the artifact until expiry. Do not place live links in public issues, analytics, durable logs, or posts intended for an unrestricted audience.</p>
          <p>If the content needs authenticated readers rather than temporary bearer access, use a system with reader accounts and per-recipient permissions.</p>
        </section>

        <section id="expiry">
          <h2>What happens when the link expires</h2>
          <p>ArtifactPass evaluates access against the exact expiry time. At the cutoff, the artifact representations become unreachable and non-cacheable through the service.</p>
          <p>Cleanup removes the source and derived objects from private R2 storage, then deletes the related metadata from D1. If a cleanup operation fails on its first attempt, the deletion state is recorded and retried. As a fallback, the public R2 lifecycle removes any remaining artifact object after 8 days, which is one day beyond the 7-day maximum link lifetime.</p>

          <figure class="figure">
            <div class="figure-frame figure-frame--card">
              <img src="assets/viewer-expired.png" alt="ArtifactPass expired link screen explaining that the temporary cutoff has been reached" width="560" height="356">
            </div>
            <figcaption>After the cutoff, the same URL shows a clear expiry state instead of the artifact.</figcaption>
          </figure>

          <div class="comparison">
            <table>
              <thead><tr><th>State</th><th>Recipient access</th><th>Storage behavior</th></tr></thead>
              <tbody>
                <tr><td>Link is live</td><td>Anyone with the URL can open and download</td><td>Source and required preview data remain in private storage</td></tr>
                <tr><td>Cutoff reached</td><td>Artifact becomes unreachable through the share URL</td><td>Cleanup is scheduled and cacheable responses are prevented</td></tr>
                <tr><td>Cleanup completes</td><td>No ArtifactPass access remains</td><td>Artifact objects and metadata are removed</td></tr>
                <tr><td>Recipient downloaded earlier</td><td>Their local copy remains</td><td>ArtifactPass cannot control an external copy</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="fit">
          <h2>Use the right sharing model</h2>
          <p>Temporary links work best when the access window is known and the artifact is a finished handoff. They are not automatically safer for every situation, and they do not replace judgment about who receives the link.</p>

          <h3>Use ArtifactPass when</h3>
          <ul>
            <li>A reviewer needs the exact file for a limited period.</li>
            <li>An AI agent created a finished artifact that should leave the chat context intact.</li>
            <li>The recipient should open the file without creating an account.</li>
            <li>A prototype or report should not become a permanent public page.</li>
          </ul>

          <h3>Use another system when</h3>
          <ul>
            <li>The document needs permanent storage, search, history, or recovery.</li>
            <li>Readers need individual accounts, revocation, or an audit trail.</li>
            <li>Several people must edit the same document.</li>
            <li>The URL is meant to rank in search or remain a stable public reference.</li>
            <li>The content requires a backend, database, or normal application hosting.</li>
          </ul>

          <p>The useful distinction is not private versus public. It is durable access versus a bounded handoff. ArtifactPass deliberately chooses the second.</p>
        </section>

        <section id="checklist">
          <h2>A quick sharing checklist</h2>
          <ol>
            <li>Remove secrets and unnecessary personal information from the file.</li>
            <li>Choose the shortest lifetime that still gives the recipient enough time.</li>
            <li>Send the link through an appropriate channel to the intended people.</li>
            <li>Explain whether the recipient should preview, inspect source, or download.</li>
            <li>Move durable knowledge into the proper repository or documentation system after review.</li>
          </ol>
        </section>

        <section class="faq" id="faq">
          <h2>Common questions</h2>
          <details>
            <summary>Can I delete a live link early?</summary>
            <p>The current public workflow centers on the selected expiry. Choose a short lifetime when early access removal is a requirement you cannot otherwise control.</p>
          </details>
          <details>
            <summary>Are ArtifactPass links private?</summary>
            <p>They are unlisted bearer links, not reader-authenticated private documents. Anyone with the live URL can open the artifact.</p>
          </details>
          <details>
            <summary>Are shared artifacts indexed by search engines?</summary>
            <p>Artifact viewer routes are excluded from indexing. The link should still be treated as a temporary secret because exclusion from search is not access control.</p>
          </details>
          <details>
            <summary>Can I use ArtifactPass as a backup?</summary>
            <p>No. Files are intentionally temporary and are removed after expiry. Keep the durable original in the appropriate source system.</p>
          </details>
        </section>`;
