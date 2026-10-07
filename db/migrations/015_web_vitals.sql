create table if not exists public.web_vitals (
  id bigserial primary key,
  observed_at timestamptz not null default now(),
  page_path text not null,
  viewport_width integer,
  viewport_height integer,
  device_pixel_ratio numeric(6,2),
  effective_connection_type text,
  save_data boolean not null default false,
  cls numeric(10,4),
  lcp_ms numeric(12,2),
  inp_ms numeric(12,2),
  fcp_ms numeric(12,2),
  ttfb_ms numeric(12,2),
  source text not null default 'martinraeburn.com',
  raw_data jsonb not null default '{}'::jsonb
);

create index if not exists web_vitals_observed_at_idx on public.web_vitals(observed_at desc);
create index if not exists web_vitals_page_observed_idx on public.web_vitals(page_path, observed_at desc);

alter table public.web_vitals enable row level security;

revoke all on table public.web_vitals from anon, authenticated;
grant all on table public.web_vitals to service_role;

insert into public.engine_settings(key,value)
values (
  'web_vitals_policy',
  '{"enabled":true,"retention_days":90,"thresholds":{"lcp_ms":2500,"inp_ms":200,"cls":0.1,"ttfb_ms":800}}'::jsonb
)
on conflict (key) do update set value=excluded.value, updated_at=now();
