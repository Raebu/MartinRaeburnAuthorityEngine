CREATE INDEX IF NOT EXISTS contacts_organization_id_idx ON contacts(organization_id);
CREATE INDEX IF NOT EXISTS opportunities_organization_id_idx ON opportunities(organization_id);
CREATE INDEX IF NOT EXISTS outreach_contact_id_idx ON outreach(contact_id);
CREATE INDEX IF NOT EXISTS outreach_opportunity_id_idx ON outreach(opportunity_id);

CREATE TABLE IF NOT EXISTS discovery_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source_type text NOT NULL,
  url text NOT NULL,
  category text,
  enabled boolean NOT NULL DEFAULT true,
  polling_minutes integer NOT NULL DEFAULT 180 CHECK (polling_minutes >= 15),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_sources_url_unique ON discovery_sources(url);
ALTER TABLE discovery_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE discovery_sources FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outreach_id uuid REFERENCES outreach(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  kind text NOT NULL DEFAULT 'follow_up',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS follow_ups_due_idx ON follow_ups(status,due_at);
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE follow_ups FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_name text NOT NULL,
  source_url text NOT NULL,
  source_title text,
  source_domain text,
  mention_type text NOT NULL DEFAULT 'mention',
  has_link boolean NOT NULL DEFAULT false,
  target_url text,
  authority_score integer CHECK (authority_score BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'new',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS mentions_entity_source_unique ON mentions(entity_name,source_url);
ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mentions FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS authority_metrics (
  id bigserial PRIMARY KEY,
  metric text NOT NULL,
  dimension text,
  value numeric NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS authority_metrics_metric_time_idx ON authority_metrics(metric,measured_at DESC);
ALTER TABLE authority_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE authority_metrics FROM anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
