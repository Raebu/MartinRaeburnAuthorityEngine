import { XMLParser } from "fast-xml-parser";
import { discoveryFeeds } from "../config.js";
import { withAdvisoryLock, sql } from "../db.js";
import { createOpportunity } from "../services/opportunities.js";

const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:"@"});

function itemsFromFeed(obj:any):any[] {
  const rss=obj?.rss?.channel?.item;
  const atom=obj?.feed?.entry;
  const value=rss ?? atom ?? [];
  return Array.isArray(value)?value:[value].filter(Boolean);
}
function text(v:any):string {
  if (typeof v==="string") return v;
  if (v?.["#text"]) return String(v["#text"]);
  return "";
}
function link(v:any):string|undefined {
  if (typeof v==="string") return v;
  if (v?.["@href"]) return String(v["@href"]);
  return undefined;
}

export async function runDiscovery() {
  return withAdvisoryLock(741002, async()=>{
    const run=(await sql<{id:number}>("INSERT INTO job_runs(job_name,status) VALUES('discovery','running') RETURNING id"))[0]!;
    let discovered=0;
    for (const feed of discoveryFeeds) {
      try {
        const r=await fetch(feed,{signal:AbortSignal.timeout(20_000)});
        if (!r.ok) continue;
        const parsed=parser.parse(await r.text());
        for (const item of itemsFromFeed(parsed).slice(0,50)) {
          const title=text(item.title).trim();
          const url=link(item.link) ?? text(item.guid).trim() || undefined;
          const summary=text(item.description || item.summary || item.content).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
          if (!title || !url) continue;
          await createOpportunity({kind:"discovered",title,sourceUrl:url,sourceName:feed,summary,rawData:item});
          discovered++;
        }
      } catch {}
    }
    await sql("UPDATE job_runs SET status='ok',finished_at=now(),details=$2::jsonb WHERE id=$1",[run.id,JSON.stringify({feeds:discoveryFeeds.length,discovered})]);
    return {feeds:discoveryFeeds.length,discovered};
  });
}
