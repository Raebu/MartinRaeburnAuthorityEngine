DROP INDEX IF EXISTS search_metrics_identity_unique;

CREATE UNIQUE INDEX IF NOT EXISTS search_metrics_identity_unique
  ON search_metrics(metric_date,query,page,country,device) NULLS NOT DISTINCT;
