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
