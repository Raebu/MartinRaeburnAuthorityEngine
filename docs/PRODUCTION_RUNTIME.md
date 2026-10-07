# Production Runtime

The Authority Engine production data plane currently runs in Supabase project `pmymiwqrinhaxktfmlhm` in `eu-west-2`.

## Live components

- PostgreSQL system of record with RLS enabled and public grants revoked
- `authority-jobs` Edge Function
- `authority-api` Edge Function
- `pg_cron` + `pg_net` scheduler
- Supabase Vault for scheduler/API credentials
- 30-minute site-health monitoring
- 3-hour opportunity-source polling
- 6-hour AI opportunity qualification
- approval-gated outbound email from `contact@martinraeburn.com`

## Schedules

- Site monitor: `*/30 * * * *`
- Discovery: `17 */3 * * *`

## Security

Both Edge Functions use server-side Supabase service-role credentials supplied by the platform.

`authority-jobs` is protected by a custom `x-job-key` whose plaintext is held in Supabase Vault. Only its SHA-256 digest is stored in application settings.

`authority-api` is protected by a custom `x-api-key` whose plaintext is held in Supabase Vault. Only its SHA-256 digest is stored in application settings.

The operational tables have RLS enabled and grants to `anon` and `authenticated` revoked. They are intentionally backend-only.

No secrets belong in this repository.

## Current production state

Site monitoring is live and has completed successfully against the primary martinraeburn.com routes.

Discovery infrastructure is live. Initial generic RSS sources are seeded, but source adapters still need expanding before opportunity discovery should be treated as production-quality.

AI-assisted inbound classification and approval-gated outreach drafting are live using a dedicated OpenAI API key stored in Supabase Vault. The production model is `gpt-5.6-luna` for cost-sensitive high-volume triage. High-impact outbound actions remain approval-gated by design.

Opportunity discovery now applies stricter freshness and intent filters, while a separate AI qualification job runs every six hours. Curated high-fit UK speaking opportunities are stored as qualified records.

Outbound email delivery is live through the verified `martinraeburn.com` Resend domain. The runtime uses a sending-only domain-restricted API credential stored in Supabase Vault. Sending remains approval-gated, suppression-aware, rate-limited to 5/hour and 20/day by default, and applies a 14-day recipient cooling-off period.

## Vercel

A linked Vercel project exists for the future private command centre / server-side integration:

- Project: `martin-raeburn-authority-engine`
- Project ID: `prj_2B7u35zRuLuZtDyl0t9TiVOtQl67`

The current Vercel connection does not have permission to write project environment variables, so no secrets are configured there yet.


## Outbound production hardening

The first-contact send path now uses a database-level reservation before contacting Resend. This makes hourly/daily caps, approval state, suppression state and recipient cooling-off checks atomic across concurrent workers.

Each outreach uses a stable Resend idempotency key derived from its outreach ID, so a retry after an ambiguous network timeout cannot create a duplicate delivery.

Recipient addresses are validated before drafts are persisted. Suppression matching is case-insensitive. Existing contact-linked drafts are backfilled with recipient addresses where possible.

After provider acceptance, the engine checks that sent state was persisted before returning success. Database/control-plane failures fail closed rather than authorising additional sends.


## Resend delivery and reply automation

The production Resend account now sends lifecycle events to the `authority-events` Supabase Edge Function.

Subscribed events:
- delivered
- delivery delayed
- bounced
- complained
- suppressed
- failed
- received

Webhook payloads are verified with the provider signing secret before processing. The signing secret is stored in Supabase Vault, not in source control.

Current automatic reactions:
- successful deliveries are written to the outreach audit trail
- replies mark the related opportunity as replied
- pending follow-ups stop immediately when a reply is received
- bounces, complaints, suppressions and failures stop follow-ups
- affected recipients are added to the suppression list
- delivery issues update the opportunity state for review
- all received provider events are stored in `email_events` for traceability

The webhook signature verifier was tested using a signed synthetic event. A synthetic reply test also confirmed that a pending follow-up is automatically completed when a reply is detected; test records were then removed from production data.


## Contact discovery and automatic follow-ups

The production `authority-automation` Edge Function now runs two additional operational loops.

### Contact discovery

Every six hours the engine inspects the highest-scoring qualified opportunities that have not yet entered outreach. It uses OpenAI web search to locate a public professional decision-maker contact relevant to the opportunity.

A discovered email is accepted only when:
- it is syntactically valid
- it is a publicly published professional address
- the AI returns a source URL and sufficiently high confidence
- the engine independently fetches that source URL and confirms the exact email is actually present
- the address is not suppressed

The engine never guesses email patterns. Verified contacts are written to the relationship store and a personalised first-contact draft plus approval request is prepared automatically. First unsolicited contact remains approval-gated.

### Automatic follow-ups

The follow-up runner executes hourly. When a previously approved and successfully sent first-contact email reaches its due date, the engine:
- checks that no reply has been received
- checks suppression state
- checks that no follow-up already exists
- creates one concise AI-generated follow-up
- authorises it under the single-follow-up automation policy
- sends it through the hardened Authority API path

The database permits only one follow-up per original outreach. Follow-ups are exempt from the new-contact cooling period only when their parent outreach is a valid sent message to the same recipient. Global hourly/daily send limits still apply.

Replies and delivery problems continue to cancel pending follow-ups immediately through the Resend event webhook.

### Schedules

- contact discovery: every six hours at minute 23
- follow-up execution: hourly at minute 11

The initial production contact-discovery run completed safely: five qualified opportunities were researched, but none met the strict public-email verification threshold, so no first-contact drafts were created. This is intentional fail-closed behaviour rather than guessing contact details.


## Expanded opportunity discovery

A dedicated web-search discovery loop now runs every three hours using a rotating catalogue of high-value searches across:
- UK speaking and keynote calls
- AI / automation / transformation conferences
- journalist and expert-comment requests
- podcasts seeking guests
- university guest-speaker opportunities
- trade associations and chambers
- awards and nominations
- advisory / NED opportunities
- accelerator / mentor / partnership programmes

The engine validates each candidate against the source page before storing it. Generic news, recaps, stale opportunities and low-scoring matches are discarded.

The first production run immediately found multiple current UK opportunities including AI Summit London, Tech Show London, CTO Craft Con Europe, Experts Live UK and Civo Navigate London.

## Private command centre

A private command centre is deployed at:

`https://pmymiwqrinhaxktfmlhm.supabase.co/functions/v1/authority-console`

The page itself contains no operational data until authenticated. The access credential is separate from the Authority API credential, and only its SHA-256 digest is stored in application settings.

The command centre shows:
- live opportunity counts
- qualified / awaiting-approval work
- emails sent and replies
- website-health failures
- pending outreach approvals
- highest-value opportunities
- recent outreach and delivery/reply state
- automation/job health
- discovery coverage

For pending outreach, Martin can explicitly **Approve & send** or **Reject** from the command centre. Approve & send uses the same hardened production Authority API, so suppression, idempotency, rate limits and recipient cooling rules still apply.


## Authority intelligence optimisation

The production engine now includes an `authority-intelligence` runtime for the optimisation layer.

### Mentions and backlink intelligence

Every six hours the engine searches for public mentions of Martin Raeburn and related authority references. Candidates are independently verified against the source page before they are stored.

The system tracks whether each mention links back to martinraeburn.com or another Raeburn property so unlinked mentions can be treated as backlink opportunities rather than being mixed with already-linked coverage.

The first production pass identified verified references including LinkedIn and Raeburn Consulting pages, with unlinked references surfaced for review.

### Relationship intelligence

Every six hours the engine refreshes a relationship score for known contacts using factual interaction signals including sent outreach, delivery, replies and prepared meetings. Scores are stored in contact metadata and a relationship-signal audit trail.

### Opportunity freshness

Every six hours the highest-priority live opportunities are revalidated against their original source URLs. Passed deadlines become `expired`; 404/410 sources become `source_unavailable`; healthy sources receive a revalidation timestamp.

The first production revalidation processed 22 active high-value opportunities: all 22 source pages were healthy.

### Conversion intelligence

A daily funnel snapshot records:
- opportunities discovered
- opportunities qualified
- verified contacts
- awaiting-approval opportunities
- outreach sent
- replies
- qualification rate
- reply rate
- mentions / linked mentions / unlinked mentions
- per-source qualification rate

This allows future source weighting and discovery strategy to be based on actual conversion rather than raw volume.

The first snapshot measured 197 opportunities discovered and 17 qualified over the initial 30-day window. Sessionize and Civo currently show the strongest observed source qualification rate in the small early dataset.

### Meeting briefs

The Authority Engine now has a production meeting-brief endpoint. Calendar events can be enriched with known contacts, organizations, outreach and opportunity history and turned into an evidence-only executive brief containing:
- objective
- relationship summary
- relevant history
- talking points
- questions to ask
- risks / unknowns
- desired next step

A live brief was successfully prepared for the confirmed UKHarvest / EGNA Highbridge Farm meeting from Martin's business calendar.

### Search Console ingestion

A production `search-console-ingest` action is available for Search Console rows. The schema supports query/page/country/device dimensions plus clicks, impressions, CTR and average position, and the command centre displays the latest 28-day visibility totals.

The GSC Wizard ChatGPT integration is connected for account-side Search Console analysis. Its ChatGPT OAuth connection is intentionally not copied into the Supabase backend. For continuous server-side ingestion, a separate production Google OAuth/service-account credential must be provisioned to the Authority Engine.
