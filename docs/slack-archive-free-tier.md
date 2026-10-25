# Slack archive: Cloudflare Free capacity

This is the Cloudflare processing budget for the optional, customer-owned Slack archive. It excludes Slack's own limits and charges. It is not an ArtifactPass package release or a guarantee of sustained throughput.

## Current transfer proof of concept

The isolated POC accepts one authenticated HTTP request per file and streams its source to Slack. It has no Slack event receiver, Queue, D1 delivery state, or automatic link detection. Cloudflare Workers Free allows 100,000 requests per day **across the account**, resetting at midnight UTC. If this POC were the account's only Worker traffic and each file needed exactly one invocation, the request-quota ceiling would be 100,000 attempted files per day, or 3,000,000 across a 30-day month. A 64 MiB synthetic transfer completed on the live Free Worker with 3 ms CPU against the 10 ms per-invocation limit. That one observation does not establish sustained throughput, concurrency, or CPU behavior for every file.

## Planned automatic bot

The [implementation plan](plans/2026-10-22-1014-feat-customer-owned-slack-archive-plan.md) uses a signed Slack event receiver, one small Queue message per qualifying file, a Queue consumer for transfer, and D1 for delivery state. Workers Free includes 10,000 Queue operations per day across the account. A successful message ordinarily uses three operations: write, read, delete. Therefore `floor(10,000 / 3) = 3,333` files per day is the **no-retry Queue ceiling**, provided there are no other Queue users in the account and each file creates only one message under 64 KB. Over 30 days, that is at most 99,990 files if every day stays within its own daily limit. This architecture is planned, not built or measured yet.

The proposed operating budget is **3,000 files per day across the team, or 90,000 in 30 days**. Its normal Queue use is 9,000 operations per day, leaving 1,000 operations for retries and other Queue activity. If retries, other apps, or messages larger than 64 KB use more than that allowance, the budget must be lowered. Worker requests, CPU, memory, D1 rows, and source reads remain independent constraints. A private ArtifactPass deployment in the same account also consumes that account's Workers and R2 allowances. The bot itself does not store an additional artifact copy in R2.

ArtifactPass currently caps agent-published artifacts at 25 MiB; the public human-upload path can accept up to 64 MiB. A file's size does not multiply the Queue operations when the message contains only a link job, but transfer CPU and memory still need qualification. R2 Standard includes 10 million Class B reads per month and free egress; one R2 read for each of 90,000 private-source files would consume 90,000 of those reads, before any other reads in that account. Public-source reads count against ArtifactPass's public service account, not the customer's private R2 bucket.

## Free-tier rule to use in setup

For the queued design, show **3,000 files/day team-wide** as the initial operating budget, not as a promise that 3,000/day has passed a load test. Display current account usage and lower the allowed count when the account already uses Workers, Queues, D1, or R2. Do not advertise the POC's 100,000/day Worker request arithmetic as the automatic bot's capacity.

## Format qualification on the isolated POC

On 2026-10-24, a test-only, authenticated route streamed three actual non-proprietary files into the private Slack trial channel. The live Worker and Slack upload API returned success for HTML (174 bytes, 513 ms), Markdown (74 bytes, 804 ms), and a generated one-page PDF (15,954 bytes, 544 ms). Slack's browser UI showed all three with their respective file types. The local mock receiver also accepted the same file bytes before the live trial.

This is **format-transfer evidence only**. The files were sent directly to the POC Worker, not published as ArtifactPass links. Event detection, fetching public or private ArtifactPass shares, posting as a reply to the source message, Queue/D1 delivery, retries, and sustained volume remain untested.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
