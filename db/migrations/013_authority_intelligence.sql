CREATE TABLE IF NOT EXISTS relationship_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  score_delta integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relationship_signals_contact_idx
  ON relationship_signals(contact_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS relationship_signals_org_idx
  ON relationship_signals(organization_id,occurred_at DESC);
ALTER TABLE relationship_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE relationship_signals FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS meeting_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_id text,
  title text NOT NULL,
  starts_at timestamptz,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL DEFAULT 'manual',
  brief jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'prepared',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_briefs_external_event_unique
  ON meeting_briefs(external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_briefs_starts_idx
  ON meeting_briefs(starts_at);
ALTER TABLE meeting_briefs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE meeting_briefs FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS search_metrics (
  id bigserial PRIMARY KEY,
  source text NOT NULL DEFAULT 'search-console',
  metric_date date NOT NULL,
  query text,
  page text,
  country text,
  device text,
  clicks numeric NOT NULL DEFAULT 0,
  impressions numeric NOT NULL DEFAULT 0,
  ctr numeric NOT NULL DEFAULT 0,
  position numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS search_metrics_identity_unique
  ON search_metrics(metric_date,coalesce(query,''),coalesce(page,''),coalesce(country,''),coalesce(device,''));
ALTER TABLE search_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE search_metrics FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS mention_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL UNIQUE,
  entity_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 50,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mention_queries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mention_queries FROM anon, authenticated;

INSERT INTO mention_queries(query,entity_name,priority) VALUES
('"Martin Raeburn" -site:martinraeburn.com','Martin Raeburn',100),
('"martinraeburn.com" -site:martinraeburn.com','martinraeburn.com',95),
('"Martin Raeburn" "Raeburn Group"','Martin Raeburn',95),
('"Martin Raeburn" AI automation technology','Martin Raeburn',90),
('"Martin Raeburn" speaker OR keynote OR podcast OR interview','Martin Raeburn',90)
ON CONFLICT (query) DO NOTHING;

INSERT INTO engine_settings(key,value) VALUES
('mention_monitor_policy','{"enabled":true,"queries_per_run":3,"minimum_authority_score":35}'::jsonb),
('relationship_policy','{"reply_bonus":30,"delivered_bonus":5,"meeting_bonus":20,"recent_decay_days":90}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
