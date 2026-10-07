import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false}}
);

function json(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}
async function sha256(value:string){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function setting(key:string){
  const {data}=await db.from("engine_settings").select("value").eq("key",key).maybeSingle();
  return data?.value??null;
}
async function secret(name:string){
  const {data,error}=await db.rpc("vault_read_secret",{secret_name:name});
  if(error||!data)throw new Error("missing secret "+name);
  return String(data);
}
async function authorised(req:Request){
  const supplied=req.headers.get("x-api-key")??req.headers.get("x-job-key");
  if(!supplied)return false;
  const api=await setting("api_key_sha256");
  const job=await setting("job_key_sha256");
  const digest=await sha256(supplied);
  return digest===api?.sha256||digest===job?.sha256;
}
async function openaiStructured(name:string,schema:any,instructions:string,input:any,useWeb=false){
  const key=await secret("openai_api_key");
  const ai=await setting("ai_model");
  const model=ai?.model||"gpt-5.6-luna";
  const payload:any={
    model,
    reasoning:{effort:"low"},
    store:false,
    instructions,
    input:JSON.stringify(input),
    text:{format:{type:"json_schema",name,strict:true,schema}}
  };
  if(useWeb)payload.tools=[{type:"web_search"}];
  const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{"authorization":"Bearer "+key,"content-type":"application/json"},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(useWeb?60000:45000)
  });
  if(!response.ok)throw new Error("OpenAI "+response.status+": "+(await response.text()).slice(0,500));
  const result=await response.json();
  for(const item of result?.output??[]){
    for(const c of item?.content??[]){
      if(c?.type==="output_text"&&typeof c.text==="string")return JSON.parse(c.text);
    }
  }
  if(typeof result?.output_text==="string")return JSON.parse(result.output_text);
  throw new Error("OpenAI response contained no output text");
}
function safePublicUrl(raw:string){
  try{
    const u=new URL(raw);
    if(!["https:","http:"].includes(u.protocol))return false;
    const h=u.hostname.toLowerCase();
    if(h==="localhost"||h.endsWith(".local")||h==="::1")return false;
    if(/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||/^169\.254\./.test(h))return false;
    const m=h.match(/^172\.(\d+)\./);
    if(m&&Number(m[1])>=16&&Number(m[1])<=31)return false;
    return true;
  }catch{return false}
}
async function pageContains(url:string,needles:string[]){
  if(!safePublicUrl(url))return false;
  const r=await fetch(url,{redirect:"follow",signal:AbortSignal.timeout(15000),headers:{"user-agent":"MartinRaeburnAuthorityEngine/1.4"}});
  if(!r.ok)return false;
  const text=(await r.text()).toLowerCase();
  return needles.some(x=>text.includes(x.toLowerCase()));
}

const mentionsSchema={
  type:"object",additionalProperties:false,
  properties:{mentions:{type:"array",maxItems:8,items:{
    type:"object",additionalProperties:false,
    properties:{
      source_url:{type:"string"},
      source_title:{type:"string"},
      source_domain:{type:"string"},
      mention_type:{type:"string",enum:["mention","profile","article","event","podcast","directory","other"]},
      has_link:{type:"boolean"},
      target_url:{type:"string"},
      authority_score:{type:"integer",minimum:0,maximum:100},
      summary:{type:"string"}
    },
    required:["source_url","source_title","source_domain","mention_type","has_link","target_url","authority_score","summary"]
  }}},
  required:["mentions"]
};

async function runMentions(){
  const policy=await setting("mention_monitor_policy")??{enabled:true,queries_per_run:3,minimum_authority_score:35};
  if(policy.enabled===false)return{disabled:true};

  const {data:run}=await db.from("job_runs").insert({job_name:"mention-monitor",status:"running"}).select("id").single();
  const {data:queries,error}=await db.from("mention_queries").select("*").eq("enabled",true)
    .order("last_run_at",{ascending:true,nullsFirst:true}).order("priority",{ascending:false})
    .limit(Number(policy.queries_per_run??3));
  if(error)throw error;

  let stored=0,skipped=0,failed=0;
  for(const q of queries??[]){
    try{
      const result=await openaiStructured(
        "authority_mentions",
        mentionsSchema,
        `Search the public web for current pages mentioning the named entity.
Return only pages that genuinely mention the entity. Prefer authoritative media, event, company, university, trade-body, podcast and directory pages.
Do not return pages owned by martinraeburn.com unless the query explicitly asks for them.
Mark has_link=true only when the page links directly to martinraeburn.com or a Raeburn Group property.
Do not invent links or scores. source_url must be the actual public page.`,
        {query:q.query,entity_name:q.entity_name,current_date:new Date().toISOString().slice(0,10)},
        true
      );

      for(const m of result.mentions??[]){
        const url=String(m.source_url??"").trim();
        if(Number(m.authority_score??0)<Number(policy.minimum_authority_score??35) || !url){
          skipped++;continue;
        }
        if(!(await pageContains(url,[q.entity_name,"Martin Raeburn","martinraeburn.com"]))){
          skipped++;continue;
        }
        const {error:upsertError}=await db.from("mentions").upsert({
          entity_name:q.entity_name,
          source_url:url,
          source_title:String(m.source_title??"").trim()||null,
          source_domain:String(m.source_domain??"").trim()||new URL(url).hostname,
          mention_type:String(m.mention_type??"mention"),
          has_link:Boolean(m.has_link),
          target_url:String(m.target_url??"").trim()||null,
          authority_score:Number(m.authority_score??0),
          status:Boolean(m.has_link)?"linked":"unlinked",
          last_seen_at:new Date().toISOString(),
          raw_data:{summary:m.summary,query:q.query}
        },{onConflict:"entity_name,source_url"});
        if(upsertError)failed++;else stored++;
      }
      await db.from("mention_queries").update({last_run_at:new Date().toISOString()}).eq("id",q.id);
    }catch(e){
      failed++;
    }
  }

  await db.from("job_runs").update({
    status:failed?"warning":"ok",
    finished_at:new Date().toISOString(),
    details:{queries:(queries??[]).length,stored,skipped,failed}
  }).eq("id",run.id);

  return{queries:(queries??[]).length,stored,skipped,failed};
}

async function runRelationshipRefresh(){
  const {data:run}=await db.from("job_runs").insert({job_name:"relationship-refresh",status:"running"}).select("id").single();

  const {data:contacts,error}=await db.from("contacts").select("id,organization_id,name,email,metadata");
  if(error)throw error;
  let updated=0;

  for(const contact of contacts??[]){
    const [{count:sent},{count:replies},{count:delivered},{count:meetings}]=await Promise.all([
      db.from("outreach").select("*",{count:"exact",head:true}).eq("contact_id",contact.id).eq("status","sent"),
      db.from("outreach").select("*",{count:"exact",head:true}).eq("contact_id",contact.id).not("reply_received_at","is",null),
      db.from("outreach").select("*",{count:"exact",head:true}).eq("contact_id",contact.id).eq("last_delivery_event","delivered"),
      db.from("meeting_briefs").select("*",{count:"exact",head:true}).contains("attendees",[{email:contact.email}])
    ]);
    const score=Math.min(100,(sent??0)*8+(delivered??0)*3+(replies??0)*30+(meetings??0)*20);
    const meta={...(contact.metadata??{}),relationship_score:score,relationship_updated_at:new Date().toISOString()};
    await db.from("contacts").update({metadata:meta,updated_at:new Date().toISOString()}).eq("id",contact.id);
    await db.from("relationship_signals").insert({
      contact_id:contact.id,
      organization_id:contact.organization_id,
      signal_type:"relationship_score_refresh",
      score_delta:score,
      details:{sent:sent??0,replies:replies??0,delivered:delivered??0,meetings:meetings??0}
    });
    updated++;
  }

  await db.from("job_runs").update({
    status:"ok",finished_at:new Date().toISOString(),details:{updated}
  }).eq("id",run.id);
  return{updated};
}

const briefSchema={
  type:"object",additionalProperties:false,
  properties:{
    objective:{type:"string"},
    relationship_summary:{type:"string"},
    relevant_history:{type:"array",items:{type:"string"}},
    talking_points:{type:"array",items:{type:"string"}},
    questions_to_ask:{type:"array",items:{type:"string"}},
    risks_or_unknowns:{type:"array",items:{type:"string"}},
    desired_next_step:{type:"string"}
  },
  required:["objective","relationship_summary","relevant_history","talking_points","questions_to_ask","risks_or_unknowns","desired_next_step"]
};

async function prepareMeetingBrief(body:any){
  if(!body?.title)return json({error:"title required"},400);
  const attendees=Array.isArray(body.attendees)?body.attendees:[];
  const emails=attendees.map((a:any)=>String(a?.email??"").toLowerCase()).filter(Boolean);

  const {data:contacts}=emails.length
    ? await db.from("contacts").select("*,organizations(*)").in("email",emails)
    : {data:[]};

  const contactIds=(contacts??[]).map((c:any)=>c.id);
  const {data:outreach}=contactIds.length
    ? await db.from("outreach").select("*").in("contact_id",contactIds).order("created_at",{ascending:false}).limit(30)
    : {data:[]};
  const oppIds=[...new Set((outreach??[]).map((o:any)=>o.opportunity_id).filter(Boolean))];
  const {data:opps}=oppIds.length
    ? await db.from("opportunities").select("*").in("id",oppIds)
    : {data:[]};

  const brief=await openaiStructured(
    "meeting_brief",
    briefSchema,
    `Prepare a concise executive meeting brief for Martin Raeburn.
Use only the supplied event, contact, relationship, outreach and opportunity data. Never invent history, commitments or facts.
Separate unknowns clearly. Focus on relationship context, useful talking points, questions and a sensible next step.`,
    {event:body,contacts:contacts??[],outreach:outreach??[],opportunities:opps??[]},
    false
  );

  let saved:any=null;
  if(body.external_event_id){
    const {data:existing,error:findError}=await db.from("meeting_briefs")
      .select("id").eq("external_event_id",String(body.external_event_id)).maybeSingle();
    if(findError)throw findError;
    if(existing?.id){
      const {data:updated,error:updateError}=await db.from("meeting_briefs").update({
        title:String(body.title),
        starts_at:body.starts_at??null,
        attendees,
        source:body.source??"api",
        brief,
        status:"prepared",
        updated_at:new Date().toISOString()
      }).eq("id",existing.id).select("id").single();
      if(updateError)throw updateError;
      saved=updated;
    }
  }
  if(!saved){
    const {data:inserted,error:insertError}=await db.from("meeting_briefs").insert({
      external_event_id:body.external_event_id??null,
      title:String(body.title),
      starts_at:body.starts_at??null,
      attendees,
      source:body.source??"api",
      brief,
      status:"prepared",
      updated_at:new Date().toISOString()
    }).select("id").single();
    if(insertError)throw insertError;
    saved=inserted;
  }
  return json({id:saved.id,brief},201);
}

async function ingestSearchMetrics(body:any){
  const rows=Array.isArray(body?.rows)?body.rows:[];
  if(rows.length===0)return json({error:"rows required"},400);
  if(rows.length>5000)return json({error:"too many rows"},400);
  let written=0;
  for(const row of rows){
    if(!row?.metric_date)continue;
    const {error}=await db.from("search_metrics").upsert({
      source:"search-console",
      metric_date:row.metric_date,
      query:row.query??null,
      page:row.page??null,
      country:row.country??null,
      device:row.device??null,
      clicks:Number(row.clicks??0),
      impressions:Number(row.impressions??0),
      ctr:Number(row.ctr??0),
      position:row.position==null?null:Number(row.position)
    },{onConflict:"metric_date,query,page,country,device"});
    if(!error)written++;
  }
  return json({written},201);
}


async function runFunnelMetrics(){
  const {data:run}=await db.from("job_runs").insert({job_name:"authority-funnel-metrics",status:"running"}).select("id").single();
  const since30=new Date(Date.now()-30*86400000).toISOString();

  const [
    discovered,qualified,awaiting,sent,replied,contacts,mentions,linkedMentions,unlinkedMentions
  ]=await Promise.all([
    db.from("opportunities").select("*",{count:"exact",head:true}).gte("created_at",since30),
    db.from("opportunities").select("*",{count:"exact",head:true}).in("status",["qualified","awaiting_approval","replied"]).gte("created_at",since30),
    db.from("opportunities").select("*",{count:"exact",head:true}).eq("status","awaiting_approval").gte("created_at",since30),
    db.from("outreach").select("*",{count:"exact",head:true}).eq("status","sent").gte("sent_at",since30),
    db.from("outreach").select("*",{count:"exact",head:true}).not("reply_received_at","is",null).gte("reply_received_at",since30),
    db.from("contacts").select("*",{count:"exact",head:true}).gte("created_at",since30),
    db.from("mentions").select("*",{count:"exact",head:true}).gte("first_seen_at",since30),
    db.from("mentions").select("*",{count:"exact",head:true}).eq("has_link",true).gte("first_seen_at",since30),
    db.from("mentions").select("*",{count:"exact",head:true}).eq("has_link",false).gte("first_seen_at",since30)
  ]);

  const discoveredN=discovered.count??0;
  const qualifiedN=qualified.count??0;
  const sentN=sent.count??0;
  const repliedN=replied.count??0;
  const now=new Date().toISOString();

  const rows=[
    ["opportunities_discovered_30d",null,discoveredN],
    ["opportunities_qualified_30d",null,qualifiedN],
    ["opportunities_awaiting_approval_30d",null,awaiting.count??0],
    ["contacts_verified_30d",null,contacts.count??0],
    ["outreach_sent_30d",null,sentN],
    ["replies_30d",null,repliedN],
    ["qualification_rate_30d",null,discoveredN?qualifiedN/discoveredN:0],
    ["reply_rate_30d",null,sentN?repliedN/sentN:0],
    ["mentions_30d",null,mentions.count??0],
    ["linked_mentions_30d",null,linkedMentions.count??0],
    ["unlinked_mentions_30d",null,unlinkedMentions.count??0]
  ];

  for(const [metric,dimension,value] of rows){
    await db.from("authority_metrics").insert({
      metric,dimension,value:Number(value),measured_at:now,metadata:{window_days:30}
    });
  }

  const {data:sourceRows}=await db.from("opportunities")
    .select("source_name,status")
    .gte("created_at",since30)
    .not("source_name","is",null);

  const grouped:Record<string,{total:number,qualified:number}>={};
  for(const row of sourceRows??[]){
    const key=String(row.source_name);
    grouped[key]??={total:0,qualified:0};
    grouped[key].total++;
    if(["qualified","awaiting_approval","replied"].includes(String(row.status)))grouped[key].qualified++;
  }
  for(const [source,v] of Object.entries(grouped)){
    if(v.total<2)continue;
    await db.from("authority_metrics").insert({
      metric:"source_qualification_rate_30d",
      dimension:source,
      value:v.qualified/v.total,
      measured_at:now,
      metadata:{total:v.total,qualified:v.qualified}
    });
  }

  await db.from("job_runs").update({
    status:"ok",finished_at:new Date().toISOString(),
    details:{discovered:discoveredN,qualified:qualifiedN,sent:sentN,replied:repliedN}
  }).eq("id",run.id);

  return{discovered:discoveredN,qualified:qualifiedN,sent:sentN,replied:repliedN};
}

async function runOpportunityRevalidation(){
  const {data:run}=await db.from("job_runs").insert({job_name:"opportunity-revalidation",status:"running"}).select("id").single();
  const {data:items,error}=await db.from("opportunities")
    .select("id,title,source_url,deadline,status,raw_data")
    .in("status",["new","qualified","review","awaiting_approval"])
    .not("source_url","is",null)
    .order("score",{ascending:false})
    .limit(30);
  if(error)throw error;

  let healthy=0,expired=0,unavailable=0,failed=0;
  for(const item of items??[]){
    try{
      if(item.deadline&&new Date(item.deadline).valueOf()<Date.now()){
        await db.from("opportunities").update({
          status:"expired",
          raw_data:{...(item.raw_data??{}),revalidation:{state:"deadline_passed",checked_at:new Date().toISOString()}},
          updated_at:new Date().toISOString()
        }).eq("id",item.id);
        expired++;
        continue;
      }
      const url=String(item.source_url);
      if(!safePublicUrl(url)){failed++;continue}
      const response=await fetch(url,{
        method:"GET",redirect:"follow",signal:AbortSignal.timeout(15000),
        headers:{"user-agent":"MartinRaeburnAuthorityEngine/1.4"}
      });
      if(response.status===404||response.status===410){
        await db.from("opportunities").update({
          status:"source_unavailable",
          raw_data:{...(item.raw_data??{}),revalidation:{state:"unavailable",http_status:response.status,checked_at:new Date().toISOString()}},
          updated_at:new Date().toISOString()
        }).eq("id",item.id);
        unavailable++;
      }else if(response.ok){
        await db.from("opportunities").update({
          raw_data:{...(item.raw_data??{}),revalidation:{state:"healthy",http_status:response.status,checked_at:new Date().toISOString()}},
          updated_at:new Date().toISOString()
        }).eq("id",item.id);
        healthy++;
      }else{
        failed++;
      }
    }catch{
      failed++;
    }
  }

  await db.from("job_runs").update({
    status:failed?"warning":"ok",
    finished_at:new Date().toISOString(),
    details:{processed:(items??[]).length,healthy,expired,unavailable,failed}
  }).eq("id",run.id);

  return{processed:(items??[]).length,healthy,expired,unavailable,failed};
}

function finiteMetric(value:unknown,max:number){
  const n=Number(value);
  return Number.isFinite(n)&&n>=0&&n<=max?n:null;
}
async function ingestWebVitals(body:any){
  const policy=await setting("web_vitals_policy")??{enabled:true,thresholds:{lcp_ms:2500,inp_ms:200,cls:0.1,ttfb_ms:800}};
  if(policy.enabled===false)return json({disabled:true});

  const path=String(body.path??"/").trim();
  if(!path.startsWith("/")||path.length>300)return json({error:"invalid path"},400);
  const viewport=Array.isArray(body.viewport)?body.viewport:[];
  const metrics=body.metrics&&typeof body.metrics==="object"?body.metrics:{};
  const row={
    observed_at:new Date(Number(body.ts)||Date.now()).toISOString(),
    page_path:path,
    viewport_width:finiteMetric(viewport[0],10000),
    viewport_height:finiteMetric(viewport[1],10000),
    device_pixel_ratio:finiteMetric(body.dpr,10),
    effective_connection_type:String(body.connection?.effectiveType??"").slice(0,32)||null,
    save_data:Boolean(body.connection?.saveData),
    cls:finiteMetric(metrics.CLS,10),
    lcp_ms:finiteMetric(metrics.LCP,120000),
    inp_ms:finiteMetric(metrics.INP,120000),
    fcp_ms:finiteMetric(metrics.FCP,120000),
    ttfb_ms:finiteMetric(metrics.TTFB,120000),
    source:"martinraeburn.com",
    raw_data:{host:String(body.host??"").slice(0,255)}
  };
  const {error}=await db.from("web_vitals").insert(row);
  if(error)throw error;

  const t=policy.thresholds??{};
  const alerts:any[]=[];
  if(row.lcp_ms!=null&&row.lcp_ms>Number(t.lcp_ms??2500))alerts.push({metric:"LCP",value:row.lcp_ms,threshold:Number(t.lcp_ms??2500)});
  if(row.inp_ms!=null&&row.inp_ms>Number(t.inp_ms??200))alerts.push({metric:"INP",value:row.inp_ms,threshold:Number(t.inp_ms??200)});
  if(row.cls!=null&&row.cls>Number(t.cls??0.1))alerts.push({metric:"CLS",value:row.cls,threshold:Number(t.cls??0.1)});
  if(row.ttfb_ms!=null&&row.ttfb_ms>Number(t.ttfb_ms??800))alerts.push({metric:"TTFB",value:row.ttfb_ms,threshold:Number(t.ttfb_ms??800)});

  return json({stored:true,alerts});
}

Deno.serve(async(req:Request)=>{
  if(req.method==="GET")return json({ok:true,service:"authority-intelligence"});
  if(!(await authorised(req)))return json({error:"unauthorized"},401);
  if(req.method!=="POST")return json({error:"method not allowed"},405);
  const body=await req.json().catch(()=>({}));
  try{
    if(body.action==="mentions")return json(await runMentions());
    if(body.action==="relationship-refresh")return json(await runRelationshipRefresh());
    if(body.action==="funnel-metrics")return json(await runFunnelMetrics());
    if(body.action==="revalidate-opportunities")return json(await runOpportunityRevalidation());
    if(body.action==="meeting-brief")return await prepareMeetingBrief(body);
    if(body.action==="search-console-ingest")return await ingestSearchMetrics(body);
    if(body.action==="web-vitals-ingest")return await ingestWebVitals(body);
    return json({error:"unknown action"},400);
  }catch(e){
    return json({error:"intelligence job failed",detail:e instanceof Error?e.message:String(e)},500);
  }
});
