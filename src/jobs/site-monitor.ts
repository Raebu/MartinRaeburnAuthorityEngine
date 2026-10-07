import { config, sitePaths } from "../config.js";
import { sql, withAdvisoryLock } from "../db.js";

export async function runSiteMonitor() {
  return withAdvisoryLock(741001, async()=>{
    const run=(await sql<{id:number}>("INSERT INTO job_runs(job_name,status) VALUES('site-monitor','running') RETURNING id"))[0]!;
    const results=[];
    for (const path of sitePaths) {
      const url=new URL(path,config.SITE_BASE_URL).toString();
      const started=Date.now();
      let status=0, ok=false, canonical:string|null=null, notes:string|null=null;
      try {
        const r=await fetch(url,{redirect:"follow",signal:AbortSignal.timeout(15_000)});
        status=r.status; ok=r.ok;
        const ct=r.headers.get("content-type")??"";
        if (ct.includes("text/html")) {
          const text=await r.text();
          canonical=text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1] ?? null;
          if (!text.toLowerCase().includes("<meta name=\"viewport\"")) notes="missing viewport meta";
        }
      } catch (e) { notes=e instanceof Error?e.message:String(e); }
      await sql("INSERT INTO site_checks(url,status_code,ok,duration_ms,canonical,notes) VALUES($1,$2,$3,$4,$5,$6)",
        [url,status||null,ok,Date.now()-started,canonical,notes]);
      results.push({url,status,ok,canonical,notes});
    }
    const failed=results.filter(x=>!x.ok);
    await sql("UPDATE job_runs SET status=$2,finished_at=now(),details=$3::jsonb WHERE id=$1",[run.id,failed.length?"warning":"ok",JSON.stringify({failed:failed.length,total:results.length})]);
    return results;
  });
}
