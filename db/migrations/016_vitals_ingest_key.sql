insert into public.engine_settings(key,value)
values ('vitals_ingest_key_sha256','{"sha256":"6665864df5a8e2b8c385e78f4c9fcbc72b64a5af1600ab271619acb929296e5b"}'::jsonb)
on conflict (key) do update set value=excluded.value, updated_at=now();
