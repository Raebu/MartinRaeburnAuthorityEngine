import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@5.2.5";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });
const sitePaths = ["/","/about/","/the-group/","/work/","/speaking/","/connect/","/thinking/","/robots.txt","/sitemap.xml"];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function authorised(req: Request) {
  const supplied = req.headers.get("x-job-key");
  if (!supplied) return false;
  const { data, error } = await db.from("engine_settings").select("value").eq("key","job_key_sha256").maybeSingle();
  if (error || !data?.value?.sha256) return false;
  return (await sha256(supplied)) === data.value.sha256;
}

async function runSiteMonitor() {
  const started = new Date().toISOString();
  const { data: run, error: runError } = await db.from("job_runs")
    .insert({ job_name:"site-monitor", status:"running", started_at:started })
    .select("id").single();
  if (runError) throw runError;

  const results = [];
  for (const path of sitePaths) {
    const url = new URL(path, "https://www.martinraeburn.com").toString();
    const t0 = Date.now();
    let status = 0, ok = false, canonical: string | null = null, notes: string | null = null;
    try {
      const response = await fetch(url, { redirect:"follow", signal:AbortSignal.timeout(15000) });
      status = response.status;
      ok = response.ok;
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/html")) {
        const text = await response.text();
        canonical = text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1] ?? null;
        if (!text.toLowerCase().includes('<meta name="viewport"')) notes = "missing viewport meta";
      }
    } catch (e) {
      notes = e instanceof Error ? e.message : String(e);
    }
    await db.from("site_checks").insert({
      url, status_code: status || null, ok, duration_ms: Date.now()-t0, canonical, notes
    });
    results.push({ url, status, ok, canonical, notes });
  }

  const failed = results.filter(x => !x.ok);
  await db.from("job_runs").update({
    status: failed.length ? "warning" : "ok",
    finished_at: new Date().toISOString(),
    details: { failed: failed.length, total: results.length }
  }).eq("id", run.id);

  return { failed: failed.length, total: results.length, results };
}

function feedItems(parsed: any): any[] {
  const value = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
  return Array.isArray(value) ? value : value ? [value] : [];
}
function asText(v: any): string {
  if (typeof v === "string") return v;
  if (v && typeof v["#text"] === "string") return v["#text"];
  return "";
}
function asLink(v: any): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v["@href"] === "string") return v["@href"];
  return undefined;
}
function simpleScore(title: string, summary: string, category = "") {
  const hay = (title+" "+summary+" "+category).toLowerCase();
  const terms = ["ai","automation","transformation","leadership","technology","recruitment","venture","entrepreneur","business","conference","summit","keynote","panel","speaker","webinar","podcast","media"];
  return Math.min(100, 20 + terms.filter(t => hay.includes(t)).length * 8);
}

async function runDiscovery() {
  const { data: run, error: runError } = await db.from("job_runs")
    .insert({ job_name:"discovery", status:"running" }).select("id").single();
  if (runError) throw runError;

  const { data: sources, error } = await db.from("discovery_sources").select("*").eq("enabled",true);
  if (error) throw error;
  let discovered = 0, failures = 0;

  for (const source of sources ?? []) {
    try {
      const response = await fetch(source.url, { signal:AbortSignal.timeout(20000), headers:{"user-agent":"MartinRaeburnAuthorityEngine/1.0"} });
      if (!response.ok) throw new Error("HTTP "+response.status);
      const parsed = parser.parse(await response.text());
      for (const item of feedItems(parsed).slice(0,50)) {
        const title = asText(item.title).trim();
        const sourceUrl = asLink(item.link) ?? (asText(item.guid).trim() || undefined);
        if (!title || !sourceUrl) continue;
        const summary = asText(item.description ?? item.summary ?? item.content).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
        const score = simpleScore(title,summary,source.category ?? "");
        const { error: upsertError } = await db.from("opportunities").upsert({
          kind: source.category ?? source.source_type ?? "discovered",
          title,
          source_url: sourceUrl,
          source_name: source.name,
          summary,
          score,
          owner_scope:"martin",
          raw_data:item,
          updated_at:new Date().toISOString()
        }, { onConflict:"source_url" });
        if (!upsertError) discovered++;
      }
      await db.from("discovery_sources").update({
        last_checked_at:new Date().toISOString(),
        last_success_at:new Date().toISOString(),
        failure_count:0
      }).eq("id",source.id);
    } catch {
      failures++;
      await db.from("discovery_sources").update({
        last_checked_at:new Date().toISOString(),
        failure_count:(source.failure_count ?? 0)+1
      }).eq("id",source.id);
    }
  }

  await db.from("job_runs").update({
    status: failures ? "warning" : "ok",
    finished_at:new Date().toISOString(),
    details:{sources:(sources??[]).length,discovered,failures}
  }).eq("id",run.id);

  return { sources:(sources??[]).length, discovered, failures };
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") return json({ ok:true, service:"authority-jobs" });
  if (req.method !== "POST") return json({ error:"method not allowed" },405);
  if (!(await authorised(req))) return json({ error:"unauthorized" },401);

  let body: any = {};
  try { body = await req.json(); } catch {}
  try {
    if (body.action === "site-monitor") return json(await runSiteMonitor());
    if (body.action === "discovery") return json(await runDiscovery());
    return json({ error:"unknown action" },400);
  } catch (e) {
    return json({ error:"job failed", detail:e instanceof Error ? e.message : String(e) },500);
  }
});
