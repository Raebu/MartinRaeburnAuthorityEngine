INSERT INTO engine_settings(key,value)
VALUES ('ai_model','{"model":"gpt-5.6-luna"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();
