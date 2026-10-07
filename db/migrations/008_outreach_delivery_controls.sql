ALTER TABLE outreach ADD COLUMN IF NOT EXISTS recipient_email text;

CREATE INDEX IF NOT EXISTS outreach_recipient_email_idx
  ON outreach(lower(recipient_email))
  WHERE recipient_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS outreach_sent_at_idx
  ON outreach(sent_at DESC)
  WHERE sent_at IS NOT NULL;

INSERT INTO engine_settings(key,value)
VALUES ('outreach_send_limits','{"hourly":5,"daily":20,"recipient_cooldown_days":14}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
