import { sql } from "../db.js";
import { scoreOpportunity } from "./scoring.js";
import { aiJson } from "./ai.js";
import { audit } from "./audit.js";

export async function createOpportunity(input:{
  kind:string; title:string; sourceUrl?:string; sourceName?:string; summary?:string;
  deadline?:string; eventDate?:string; location?:string; rawData?:unknown;
}) {
  const deterministic=scoreOpportunity(input);
  const ai=await aiJson<{score:number;fit_reason:string;owner_scope:string;kind?:string}>(
    "Evaluate an authority opportunity for Martin Raeburn. Score 0-100 for relevance to speaking, media, strategic relationships, business authority, or the Raeburn portfolio. owner_scope must be one of martin,group,consulting,technology,automation,recruitment,ventures,digitalassets.",
    input
  ).catch(()=>null);
  const score=Math.max(deterministic, Math.min(100,Math.max(0,ai?.score ?? 0)));
  const rows=await sql<{id:string}>(
    `INSERT INTO opportunities(kind,title,source_url,source_name,event_date,deadline,location,summary,score,fit_reason,owner_scope,raw_data)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (source_url) WHERE source_url IS NOT NULL
     DO UPDATE SET updated_at=now(), title=EXCLUDED.title, summary=EXCLUDED.summary, score=GREATEST(opportunities.score,EXCLUDED.score)
     RETURNING id`,
    [ai?.kind ?? input.kind,input.title,input.sourceUrl??null,input.sourceName??null,input.eventDate??null,input.deadline??null,input.location??null,input.summary??null,score,ai?.fit_reason??null,ai?.owner_scope??"martin",JSON.stringify(input.rawData??{})]
  );
  const id=rows[0]!.id;
  await audit("system","opportunity.upsert","opportunity",id,{score});
  return id;
}

export async function listOpportunities(limit=50,status?:string) {
  return sql(
    `SELECT * FROM opportunities WHERE ($1::text IS NULL OR status=$1) ORDER BY score DESC, created_at DESC LIMIT $2`,
    [status??null,limit]
  );
}
