ALTER TABLE outreach
  ADD COLUMN IF NOT EXISTS send_reserved_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

UPDATE outreach o
SET recipient_email = lower(c.email)
FROM contacts c
WHERE o.contact_id = c.id
  AND o.recipient_email IS NULL
  AND c.email IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reserve_outreach_send(
  p_outreach_id uuid,
  p_hourly_limit integer,
  p_daily_limit integer,
  p_cooldown_days integer
)
RETURNS SETOF outreach
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row outreach%ROWTYPE;
  v_hourly integer;
  v_daily integer;
  v_recent integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('authority-outreach-send'));

  SELECT * INTO v_row
  FROM outreach
  WHERE id = p_outreach_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outreach_not_found';
  END IF;

  IF v_row.status = 'sent' THEN
    RAISE EXCEPTION 'already_sent';
  END IF;

  IF v_row.recipient_email IS NULL OR btrim(v_row.recipient_email) = '' THEN
    RAISE EXCEPTION 'recipient_missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM approvals a
    WHERE a.target_type = 'outreach'
      AND a.target_id = v_row.id
      AND a.action_type = 'send_outreach'
      AND a.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'approval_required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM suppressions s
    WHERE lower(s.email) = lower(v_row.recipient_email)
  ) THEN
    RAISE EXCEPTION 'recipient_suppressed';
  END IF;

  SELECT count(*) INTO v_hourly
  FROM outreach
  WHERE status IN ('sent','sending')
    AND COALESCE(sent_at,send_reserved_at) >= now() - interval '1 hour';

  IF v_hourly >= p_hourly_limit THEN
    RAISE EXCEPTION 'hourly_limit_reached';
  END IF;

  SELECT count(*) INTO v_daily
  FROM outreach
  WHERE status IN ('sent','sending')
    AND COALESCE(sent_at,send_reserved_at) >= now() - interval '24 hours';

  IF v_daily >= p_daily_limit THEN
    RAISE EXCEPTION 'daily_limit_reached';
  END IF;

  SELECT count(*) INTO v_recent
  FROM outreach
  WHERE id <> v_row.id
    AND status = 'sent'
    AND lower(recipient_email) = lower(v_row.recipient_email)
    AND sent_at >= now() - make_interval(days => p_cooldown_days);

  IF v_recent > 0 THEN
    RAISE EXCEPTION 'recipient_cooldown_active';
  END IF;

  UPDATE outreach
  SET status = 'sending',
      send_reserved_at = COALESCE(send_reserved_at,now()),
      last_error = NULL,
      updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN NEXT v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_outreach_send(uuid,integer,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_outreach_send(uuid,integer,integer,integer)
  TO service_role;
