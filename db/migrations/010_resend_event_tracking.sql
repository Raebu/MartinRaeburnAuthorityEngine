ALTER TABLE outreach
  ADD COLUMN IF NOT EXISTS last_delivery_event text,
  ADD COLUMN IF NOT EXISTS last_delivery_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_received_at timestamptz;

CREATE TABLE IF NOT EXISTS email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text UNIQUE,
  provider_message_id text,
  event_type text NOT NULL,
  recipient_email text,
  sender_email text,
  subject text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_events_message_idx
  ON email_events(provider_message_id,created_at DESC);

CREATE INDEX IF NOT EXISTS email_events_sender_idx
  ON email_events(lower(sender_email),created_at DESC);

ALTER TABLE email_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE email_events FROM anon, authenticated;
