# Slack archive: Cloudflare Free capacity

This is the Cloudflare processing budget for the optional, customer-owned Slack archive. It excludes Slack's own limits and charges. It is not an ArtifactPass package release or a guarantee of sustained throughput.

## Current transfer proof of concept

The isolated POC accepts one authenticated HTTP request per file and streams its source to Slack. It has no Slack event receiver, Queue, D1 delivery state, or automatic link detection. Cloudflare Workers Free allows 100,000 requests per day **across the account**, resetting at midnight UTC. If this POC were the account's only Worker traffic and each file needed exactly one invocation, the request-quota ceiling would be 100,000 attempted files per day, or 3,000,000 across a 30-day month. A 64 MiB synthetic transfer completed on the live Free Worker with 3 ms CPU against the 10 ms per-invocation limit. This was a direct transfer stress test, not a 64 MiB ArtifactPass share; ArtifactPass's per-artifact maximum is 25 MiB. That one observation does not establish sustained throughput, concurrency, or CPU behavior for every file.

## Automatic bot: live pilot and planning budget

The live pilot uses a signed Slack event receiver, one small Queue message per qualifying file, a Queue consumer for transfer, and D1 for delivery state. It has archived posted public and private ArtifactPass links into their originating Slack threads. A private 25 MiB Markdown source produced one Slack file and a successful delivery record; the downloaded Slack file's SHA-256 matched the source (`bbda805d5e3dda19697441d724d52fbc618520f1b0b70ba9732e25b2bf867932`). This is the current maximum ArtifactPass artifact size. Disabled-channel and unapproved-origin links created no copy. An invalid link produced an inspectable `source_unavailable` failure. A message containing the same link twice produced one file.

Workers Free includes 10,000 Queue operations per day across the account. A successful message ordinarily uses three operations: write, read, delete. The pilot Queue dashboard showed five ingested and acknowledged messages using 15 operations, with zero retries in that sample. This is evidence for the normal three-operation path, not a sustained-load result. `floor(10,000 / 3) = 3,333` files per day is the **no-retry Queue ceiling**, provided there are no other Queue users in the account and each file creates only one message under 64 KB. Over 30 days, that is at most 99,990 files if every day stays within its own daily limit.

The pilot Worker's rolling 24-hour dashboard showed 37 invocations, 46 subrequests, zero Worker errors, 5.92 ms P99 CPU, and 1.58 MB P99 memory after the 25 MiB transfer. These totals include setup and negative-case traffic, and the dashboard may lag live delivery status. They do not establish per-file worst-case CPU, memory, or a sustainable daily rate.

A separate 15-minute private source was archived while live. After its expiry, ArtifactPass returned `not_found`, while the existing Slack file remained downloadable with the same SHA-256 as the source. A fresh Slack post of that already-expired URL has not yet been verified in the live pilot; the invalid-link case above is not a substitute for that specific check.

The proposed operating budget is **3,000 files per day across the team, or 90,000 in 30 days**. Its normal Queue use is 9,000 operations per day, leaving 1,000 operations for retries and other Queue activity. This is a quota-derived planning number, **not a volume that has been load-tested**. If retries, other apps, or messages larger than 64 KB use more than that allowance, the budget must be lowered. Worker requests, CPU, memory, D1 rows, and source reads remain independent constraints. A private ArtifactPass deployment in the same account also consumes that account's Workers and R2 allowances. The bot itself does not store an additional artifact copy in R2.

ArtifactPass currently caps both agent-published artifacts and human uploads at 25 MiB per artifact. The public upload service's 64 MiB constant is a rolling per-publisher upload budget, not the single-file limit. A file's size does not multiply the Queue operations when the message contains only a link job, but transfer CPU and memory still need qualification. R2 Standard includes 10 million Class B reads per month and free egress; one R2 read for each of 90,000 private-source files would consume 90,000 of those reads, before any other reads in that account. Public-source reads count against ArtifactPass's public service account, not the customer's private R2 bucket.

## Free-tier rule to use in setup

For the queued design, show **3,000 files/day team-wide** as an upper planning budget, not as a promise that 3,000/day has passed a load test. Subtract the account's other Queue operations first, reserve room for retries, and lower the count when Workers, D1, or R2 usage is closer to its own limit. Do not advertise the POC's 100,000/day Worker request arithmetic as the automatic bot's capacity.

## Format qualification on the isolated POC

On 2026-10-24, a test-only, authenticated route streamed three actual non-proprietary files into the private Slack trial channel. The live Worker and Slack upload API returned success for HTML (174 bytes, 513 ms), Markdown (74 bytes, 804 ms), and a generated one-page PDF (15,954 bytes, 544 ms). Slack's browser UI showed all three with their respective file types. The local mock receiver also accepted the same file bytes before the live trial.

This is **format-transfer evidence only**. The files were sent directly to the POC Worker, not published as ArtifactPass links. Event detection, fetching public or private ArtifactPass shares, posting as a reply to the source message, Queue/D1 delivery, retries, and sustained volume remain untested.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
