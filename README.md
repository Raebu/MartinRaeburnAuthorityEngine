# Martin Raeburn Authority Engine

Production backend for **authority, opportunities, relationships, reputation and site health** supporting martinraeburn.com and, later, the wider Raeburn portfolio.

## Scope

This repository intentionally **does not implement editorial/article generation**. Editorial automation is being developed separately and should integrate through an API later rather than be duplicated here.

### Implemented foundation

- speaking / event / media / strategic opportunity store and scoring
- feed-based and AI web-search opportunity discovery
- AI-assisted inbound classification
- AI-assisted, approval-gated outreach drafting
- outbound suppression handling
- explicit human approval before sending
- Resend delivery adapter for `contact@martinraeburn.com`
- organisation/contact relationship model
- martinraeburn.com site-health checks
- job/audit logs
- private dashboard summary API and command centre
- singleton workers via PostgreSQL advisory locks
- Docker development/runtime setup
- CI validation
- API-key protection for operational endpoints

## Architecture

```
Public sources / feeds / future search providers
                    |
                    v
          Discovery + scoring
                    |
           PostgreSQL system of record
          /          |          \
 opportunities    contacts    approvals
       |              |           |
       +--------- outreach --------+
                    |
               Resend/email

martinraeburn.com ---> private API ---> Authority Engine

worker ---> discovery / monitoring / future follow-up jobs
```

## Human approval model

The engine may research, score, classify and draft autonomously.

External actions with reputational consequences are approval-gated. Outbound email cannot be sent unless an associated approval has explicitly been marked `approved`. Suppressed recipients are blocked even after approval.

## Local development

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run dev
```

API health:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

Protected endpoints require:

```
x-api-key: <API_KEY>
```

## Main endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /v1/opportunities`
- `POST /v1/inbound/classify`
- `POST /v1/outreach/draft`
- `GET /v1/approvals`
- `POST /v1/approvals/:id/decision`
- `POST /v1/outreach/:id/send`
- `POST /v1/suppressions`
- `GET /v1/dashboard/summary`
- `POST /v1/jobs/site-monitor/run`
- `POST /v1/jobs/discovery/run`

## Production configuration

Configure:

- managed PostgreSQL
- `API_KEY`
- `OPENAI_API_KEY` for classification/drafting
- `RESEND_API_KEY` and verified `contact@martinraeburn.com`
- discovery feeds or future search-provider adapters
- API and worker as separate processes

The public website remains independent: Authority Engine failures should not take martinraeburn.com down.

## Planned modules

The data model/API foundation is deliberately ready for:

- additional first-party conference / media source adapters
- strategic relationship discovery
- Search Console intelligence
- backlink / mention monitoring
- award and expert-register discovery
- calendar / meeting briefing
- Gmail/Google Workspace relationship history
- richer CRM timelines and follow-up state
- deployment QA / Core Web Vitals ingestion
- executive authority dashboard
- integration with the separate editorial engine

## Non-goals

- mass cold-email spam
- fabricated achievements, client claims or metrics
- autonomous high-risk media/public statements
- duplicate editorial/article generation
