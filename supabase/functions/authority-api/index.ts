import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});

function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
async function sha256(value:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("")}
async function authorised(req:Request){
  const supplied=req.headers.get("x-api-key"); if(!supplied) return false;
  const {data,error}=await db.from("engine_settings").select("value").eq("key","api_key_sha256").maybeSingle();
  if(error||!data?.value?.sha256) return false;
  return (await sha256(supplied))===data.value.sha256;
}
async function audit(action:string,entityType?:string,entityId?:string,details:Record<string,unknown>={}){
  await db.from("audit_logs").insert({actor:"edge-api",action,entity_type:entityType??null,entity_id:entityId??null,details});
}
function classify(message:string,subject=""){
  const hay=(subject+" "+message).toLowerCase();
  const rules=[
    ["speaking",["speaker","speaking","keynote","conference","panel","webinar","event"]],
    ["media",["journalist","interview","podcast","press","media","comment","editor"]],
    ["board",["board","non-executive","ned","director"]],
    ["partnership",["partner","partnership","collaboration","joint venture"]],
    ["investment",["invest","investment","funding","investor"]],
    ["recruitment",["recruit","candidate","hiring","talent"]],
    ["consulting",["consult","transformation","strategy","advisory","automation","ai project"]],
    ["product",["software","platform","product","demo"]]
  ] as const;
  let category="general",hits=0;
  for(const [name,terms] of rules){const n=terms.filter(t=>hay.includes(t)).length;if(n>hits){hits=n;category=name}}
  const urgency=["urgent","asap","this week","deadline","tomorrow"].some(t=>hay.includes(t))?20:0;
  const priority=Math.min(100,45+hits*12+urgency);
  const scopes:Record<string,string>={speaking:"martin",media:"martin",board:"martin",partnership:"group",investment:"ventures",recruitment:"recruitment",consulting:"consulting",product:"technology",general:"martin"};
  return {category,priority,recommended_scope:scopes[category]??"martin",recommended_action:priority>=75?"review promptly":"review"};
}

Deno.serve(async(req:Request)=>{
  const url=new URL(req.url);
  const suffix=url.pathname.split("/authority-api")[1]||"/";
  if(req.method==="GET"&&suffix==="/healthz") return json({ok:true,service:"authority-api"});
  if(!(await authorised(req))) return json({error:"unauthorized"},401);

  try{
    if(req.method==="GET"&&suffix==="/dashboard"){
      const [{count:opp},{count:pending},{count:inbound},{count:failures}]=await Promise.all([
        db.from("opportunities").select("*",{count:"exact",head:true}).eq("status","new"),
        db.from("approvals").select("*",{count:"exact",head:true}).eq("status","pending"),
        db.from("inbound_enquiries").select("*",{count:"exact",head:true}).gte("priority",75),
        db.from("site_checks").select("*",{count:"exact",head:true}).eq("ok",false).gte("checked_at",new Date(Date.now()-86400000).toISOString())
      ]);
      return json({opportunities_new:opp??0,approvals_pending:pending??0,high_priority_inbound:inbound??0,site_failures_24h:failures??0});
    }

    if(req.method==="GET"&&suffix==="/opportunities"){
      const limit=Math.max(1,Math.min(200,Number(url.searchParams.get("limit")||50)));
      let q=db.from("opportunities").select("*").order("score",{ascending:false}).order("created_at",{ascending:false}).limit(limit);
      const status=url.searchParams.get("status"); if(status) q=q.eq("status",status);
      const {data,error}=await q; if(error) throw error;
      return json({items:data??[]});
    }

    if(req.method==="POST"&&suffix==="/inbound/classify"){
      const body=await req.json();
      if(!body?.message||typeof body.message!=="string") return json({error:"message required"},400);
      const a=classify(body.message,body.subject||"");
      const {data,error}=await db.from("inbound_enquiries").insert({
        name:body.name??null,email:body.email??null,organization:body.organization??null,subject:body.subject??null,message:body.message,
        category:a.category,priority:a.priority,recommended_scope:a.recommended_scope,recommended_action:a.recommended_action,
        analysis:{mode:"deterministic",...a}
      }).select("id").single();
      if(error) throw error;
      await audit("inbound.classified","inbound",data.id,{priority:a.priority,category:a.category});
      return json({id:data.id,...a},201);
    }

    if(req.method==="GET"&&suffix==="/approvals"){
      const {data,error}=await db.from("approvals").select("*").eq("status","pending").order("requested_at");
      if(error) throw error; return json({items:data??[]});
    }

    const decision=suffix.match(/^\/approvals\/([0-9a-f-]+)\/decision$/i);
    if(req.method==="POST"&&decision){
      const body=await req.json(); const value=body?.decision;
      if(value!=="approved"&&value!=="rejected") return json({error:"decision must be approved or rejected"},400);
      const {data,error}=await db.from("approvals").update({status:value,decided_at:new Date().toISOString(),decided_by:body.actor??"api"}).eq("id",decision[1]).eq("status","pending").select("*").maybeSingle();
      if(error) throw error; if(!data) return json({error:"approval not found or already decided"},404);
      await audit("approval."+value,data.target_type,data.target_id,{approval_id:data.id});
      return json(data);
    }

    if(req.method==="POST"&&suffix==="/suppressions"){
      const body=await req.json();
      if(!body?.email||!body?.reason) return json({error:"email and reason required"},400);
      const {error}=await db.from("suppressions").upsert({email:String(body.email).toLowerCase(),reason:body.reason,source:body.source??"manual"},{onConflict:"email"});
      if(error) throw error; await audit("suppression.upsert","email",String(body.email).toLowerCase());
      return json({ok:true},201);
    }

    if(req.method==="GET"&&suffix==="/site-health"){
      const {data,error}=await db.from("site_checks").select("url,status_code,ok,duration_ms,canonical,notes,checked_at").order("checked_at",{ascending:false}).limit(30);
      if(error) throw error; return json({items:data??[]});
    }

    return json({error:"not found"},404);
  }catch(e){return json({error:"internal error",detail:e instanceof Error?e.message:String(e)},500)}
});
