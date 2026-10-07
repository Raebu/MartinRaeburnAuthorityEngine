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

AI-assisted classification/drafting and outbound email remain disabled until runtime credentials are provisioned. High-impact outbound actions remain approval-gated by design.

## Vercel

A linked Vercel project exists for the future private command centre / server-side integration:

- Project: `martin-raeburn-authority-engine`
- Project ID: `prj_2B7u35zRuLuZtDyl0t9TiVOtQl67`

The current Vercel connection does not have permission to write project environment variables, so no secrets are configured there yet.
