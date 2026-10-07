CREATE TABLE IF NOT EXISTS authority_search_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  query text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 50,
  cadence_hours integer NOT NULL DEFAULT 12,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS authority_search_queries_query_unique
  ON authority_search_queries(query);

ALTER TABLE authority_search_queries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE authority_search_queries FROM anon, authenticated;

INSERT INTO authority_search_queries(category,query,priority,cadence_hours) VALUES
('speaking','UK call for speakers AI automation business transformation conference 2027',100,6),
('speaking','UK keynote panel speaker applications technology leadership conference 2027',95,6),
('speaking','London call for speakers artificial intelligence automation leadership',95,6),
('speaking','Hampshire Surrey Dorset business technology conference call for speakers',90,12),
('media','UK journalist request expert comment AI automation business technology',95,6),
('media','UK media looking for expert commentary artificial intelligence business transformation',90,6),
('podcast','UK business podcast looking for guests AI automation founder technology',90,12),
('podcast','leadership entrepreneurship technology podcast guest application UK',85,12),
('university','UK university guest speaker entrepreneur AI automation technology business',90,12),
('association','UK trade association speaker call technology AI transformation recruitment',90,12),
('awards','UK business technology awards nominations entrepreneur AI automation deadline',80,24),
('advisory','UK advisory board non executive opportunity technology AI scaleup entrepreneur',80,24),
('partnership','UK chamber of commerce speaker business event technology AI',85,12),
('partnership','UK accelerator mentor expert entrepreneur technology programme applications',85,12)
ON CONFLICT (query) DO NOTHING;

INSERT INTO engine_settings(key,value)
VALUES (
  'web_discovery_policy',
  '{"enabled":true,"queries_per_run":4,"results_per_query":6,"minimum_score":72,"max_page_age_days":365}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
