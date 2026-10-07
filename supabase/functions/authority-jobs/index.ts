import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@5.2.5";

const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:"@"});
const sitePaths=["/","/about/","/the-group/","/work/","/speaking/","/connect/","/thinking/","/robots.txt","/sitemap.xml"];

function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
async function sha256(v:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("")}
async function setting(key:string){const {data}=await db.from("engine_settings").select("value").eq("key",key).maybeSingle();return data?.value??null}
async function secret(name:string){const {data,error}=await db.rpc("vault_read_secret",{secret_name:name});if(error||!data) throw new Error("missing secret "+name);return String(data)}
async function authorised(req:Request){const supplied=req.headers.get("x-job-key");if(!supplied)return false;const expected=await setting("job_key_sha256");return !!expected?.sha256&&(await sha256(supplied))===expected.sha256}
function extractText(payload:any){for(const item of payload?.output??[])for(const c of item?.content??[])if(c?.type==="output_text"&&typeof c.text==="string")return c.text;if(typeof payload?.output_text==="string")return payload.output_text;throw new Error("OpenAI response contained no output text")}
async function openaiStructured(name:string,schema:any,instructions:string,input:any){
  const key=await secret("openai_api_key");const ai=await setting("ai_model");const model=ai?.model||"gpt-5.6-luna";
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"authorization":"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model,reasoning:{effort:"low"},store:false,instructions,input:JSON.stringify(input),text:{format:{type:"json_schema",name,strict:true,schema}}}),signal:AbortSignal.timeout(45000)});
  if(!r.ok) throw new Error("OpenAI "+r.status+": "+(await r.text()).slice(0,500));
  return JSON.parse(extractText(await r.json()));
}

async function runSiteMonitor(){
  const {data:run,error:runError}=await db.from("job_runs").insert({job_name:"site-monitor",status:"running"}).select("id").single();if(runError)throw runError;
  const results=[];
  for(const path of sitePaths){
    const url=new URL(path,"https://www.martinraeburn.com").toString();const t0=Date.now();let status=0,ok=false,canonical:string|null=null,notes:string|null=null;
    try{const response=await fetch(url,{redirect:"follow",signal:AbortSignal.timeout(15000)});status=response.status;ok=response.ok;const type=response.headers.get("content-type")??"";if(type.includes("text/html")){const body=await response.text();canonical=body.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1]??null;if(!body.toLowerCase().includes('<meta name="viewport"'))notes="missing viewport meta"}}catch(e){notes=e instanceof Error?e.message:String(e)}
    await db.from("site_checks").insert({url,status_code:status||null,ok,duration_ms:Date.now()-t0,canonical,notes});results.push({url,status,ok,canonical,notes});
  }
  const failed=results.filter(x=>!x.ok);await db.from("job_runs").update({status:failed.length?"warning":"ok",finished_at:new Date().toISOString(),details:{failed:failed.length,total:results.length}}).eq("id",run.id);
  return{failed:failed.length,total:results.length,results};
}

function feedItems(parsed:any){const v=parsed?.rss?.channel?.item??parsed?.feed?.entry??[];return Array.isArray(v)?v:v?[v]:[]}
function asText(v:any){if(typeof v==="string")return v;if(v&&typeof v["#text"]==="string")return v["#text"];return ""}
function asLink(v:any){if(typeof v==="string")return v;if(v&&typeof v["@href"]==="string")return v["@href"];return undefined}
function parseDate(item:any){const raw=asText(item.pubDate??item.published??item.updated??"");const d=raw?new Date(raw):null;return d&&!Number.isNaN(d.valueOf())?d:null}
function relevantTitle(title:string,category:string){
  const t=title.toLowerCase();
  if(category==="speaking")return ["call for speakers","call for speaker","speaker submissions","speaking opportunity","submit your session","seeking speakers","speaker applications"].some(x=>t.includes(x));
  if(category==="media")return ["seeking guests","looking for guests","guest applications","expert comment","journalist request","expert source","media request"].some(x=>t.includes(x));
  return true;
}
function simpleScore(title:string,summary:string,category=""){
  const hay=(title+" "+summary).toLowerCase();let score=25;
  if(/call for speakers|speaker submissions|seeking speakers|submit your session/.test(hay))score+=35;
  if(/ai|artificial intelligence|automation|agent/.test(hay))score+=12;
  if(/business|leadership|transformation|technology|data|recruitment/.test(hay))score+=10;
  if(/london|united kingdom|\buk\b|england|hampshire|reading|bournemouth/.test(hay))score+=12;
  if(category==="media"&&/expert comment|journalist request|expert source/.test(hay))score+=20;
  return Math.min(100,score);
}

async function runDiscovery(){
  const {data:run,error:runError}=await db.from("job_runs").insert({job_name:"discovery",status:"running"}).select("id").single();if(runError)throw runError;
  const {data:sources,error}=await db.from("discovery_sources").select("*").eq("enabled",true);if(error)throw error;
  let discovered=0,failures=0,filtered=0;
  for(const source of sources??[]){
    try{
      const response=await fetch(source.url,{signal:AbortSignal.timeout(20000),headers:{"user-agent":"MartinRaeburnAuthorityEngine/1.1"}});if(!response.ok)throw new Error("HTTP "+response.status);
      const parsed=parser.parse(await response.text());
      for(const item of feedItems(parsed).slice(0,50)){
        const title=asText(item.title).trim();const sourceUrl=asLink(item.link)??(asText(item.guid).trim()||undefined);if(!title||!sourceUrl)continue;
        const published=parseDate(item);if(published&&Date.now()-published.valueOf()>1000*60*60*24*120){filtered++;continue}
        if(!relevantTitle(title,source.category??"")){filtered++;continue}
        const summary=asText(item.description??item.summary??item.content).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
        const score=simpleScore(title,summary,source.category??"");
        const {error:upsertError}=await db.from("opportunities").upsert({kind:source.category??source.source_type??"discovered",title,source_url:sourceUrl,source_name:source.name,summary,score,owner_scope:"martin",raw_data:item,updated_at:new Date().toISOString()},{onConflict:"source_url"});
        if(!upsertError)discovered++;
      }
      await db.from("discovery_sources").update({last_checked_at:new Date().toISOString(),last_success_at:new Date().toISOString(),failure_count:0}).eq("id",source.id);
    }catch{failures++;await db.from("discovery_sources").update({last_checked_at:new Date().toISOString(),failure_count:(source.failure_count??0)+1}).eq("id",source.id)}
  }
  await db.from("job_runs").update({status:failures?"warning":"ok",finished_at:new Date().toISOString(),details:{sources:(sources??[]).length,discovered,filtered,failures}}).eq("id",run.id);
  return{sources:(sources??[]).length,discovered,filtered,failures};
}

const qualificationSchema={type:"object",additionalProperties:false,properties:{
  score:{type:"integer",minimum:0,maximum:100},
  decision:{type:"string",enum:["qualified","review","rejected"]},
  fit_reason:{type:"string"},
  suggested_topic:{type:"string"},
  urgency:{type:"string",enum:["low","medium","high"]},
  risks:{type:"array",items:{type:"string"}}
},required:["score","decision","fit_reason","suggested_topic","urgency","risks"]};

async function runQualification(){
  const {data:run,error:runError}=await db.from("job_runs").insert({job_name:"opportunity-qualification",status:"running"}).select("id").single();if(runError)throw runError;
  const {data:items,error}=await db.from("opportunities").select("*").eq("status","new").gte("score",45).order("score",{ascending:false}).limit(12);if(error)throw error;
  let qualified=0,rejected=0,review=0,failed=0;
  for(const item of items??[]){
    try{
      const result=await openaiStructured("opportunity_qualification",qualificationSchema,
        "You qualify external authority opportunities for Martin Raeburn. Prioritise credible UK speaking, media, university, association, board/advisory and strategic relationship opportunities that fit practical AI, automation, business building, technology, transformation and recruitment. Prefer real open opportunities with actionable next steps. Reject stale, irrelevant, promotional or merely news-about-someone-else items. Never invent facts.",
        item);
      const status=result.decision==="qualified"?"qualified":result.decision==="rejected"?"rejected":"review";
      await db.from("opportunities").update({score:result.score,status,fit_reason:result.fit_reason,raw_data:{...(item.raw_data??{}),qualification:{suggested_topic:result.suggested_topic,urgency:result.urgency,risks:result.risks}},updated_at:new Date().toISOString()}).eq("id",item.id);
      if(status==="qualified")qualified++;else if(status==="rejected")rejected++;else review++;
    }catch{failed++}
  }
  await db.from("job_runs").update({status:failed?"warning":"ok",finished_at:new Date().toISOString(),details:{processed:(items??[]).length,qualified,rejected,review,failed}}).eq("id",run.id);
  return{processed:(items??[]).length,qualified,rejected,review,failed};
}

Deno.serve(async(req:Request)=>{
  if(req.method==="GET")return json({ok:true,service:"authority-jobs",ai:true});
  if(req.method!=="POST")return json({error:"method not allowed"},405);
  if(!(await authorised(req)))return json({error:"unauthorized"},401);
  let body:any={};try{body=await req.json()}catch{}
  try{
    if(body.action==="site-monitor")return json(await runSiteMonitor());
    if(body.action==="discovery")return json(await runDiscovery());
    if(body.action==="qualify")return json(await runQualification());
    return json({error:"unknown action"},400);
  }catch(e){return json({error:"job failed",detail:e instanceof Error?e.message:String(e)},500)}
});