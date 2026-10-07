import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});

function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
async function sha256(value:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("")}
async function setting(key:string){const {data}=await db.from("engine_settings").select("value").eq("key",key).maybeSingle();return data?.value??null}
async function secret(name:string){
  const {data,error}=await db.rpc("vault_read_secret",{secret_name:name});
  if(!error&&data) return String(data);
  const {data:rows,error:sqlError}=await db.from("decrypted_secrets").select("decrypted_secret").eq("name",name).limit(1);
  if(sqlError||!rows?.[0]?.decrypted_secret) throw new Error("missing secret "+name);
  return String(rows[0].decrypted_secret);
}
async function authorised(req:Request){
  const supplied=req.headers.get("x-api-key"); if(!supplied) return false;
  const expected=await setting("api_key_sha256"); if(!expected?.sha256) return false;
  return (await sha256(supplied))===expected.sha256;
}
async function audit(action:string,entityType?:string,entityId?:string,details:Record<string,unknown>={}){
  await db.from("audit_logs").insert({actor:"edge-api",action,entity_type:entityType??null,entity_id:entityId??null,details});
}
function fallbackClassify(message:string,subject=""){
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
  return {category,priority,recommended_scope:scopes[category]??"martin",recommended_action:priority>=75?"review promptly":"review",rationale:"Deterministic fallback classification."};
}
function extractText(payload:any){
  for(const item of payload?.output??[]) for(const c of item?.content??[]) if(c?.type==="output_text"&&typeof c.text==="string") return c.text;
  if(typeof payload?.output_text==="string") return payload.output_text;
  throw new Error("OpenAI response contained no output text");
}
async function openaiStructured(name:string,schema:any,instructions:string,input:any){
  const key=await secret("openai_api_key");
  const ai=await setting("ai_model");
  const model=ai?.model||"gpt-5.6-luna";
  const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{"authorization":"Bearer "+key,"content-type":"application/json"},
    body:JSON.stringify({
      model,
      reasoning:{effort:"low"},
      store:false,
      instructions,
      input:JSON.stringify(input),
      text:{format:{type:"json_schema",name,strict:true,schema}}
    }),
    signal:AbortSignal.timeout(45000)
  });
  if(!response.ok) throw new Error("OpenAI "+response.status+": "+(await response.text()).slice(0,500));
  return JSON.parse(extractText(await response.json()));
}

const classificationSchema={
  type:"object",additionalProperties:false,
  properties:{
    category:{type:"string",enum:["speaking","media","board","partnership","investment","recruitment","consulting","product","general"]},
    priority:{type:"integer",minimum:0,maximum:100},
    recommended_scope:{type:"string",enum:["martin","group","consulting","technology","automation","recruitment","ventures","digital-assets"]},
    recommended_action:{type:"string"},
    rationale:{type:"string"},
    risks:{type:"array",items:{type:"string"}}
  },
  required:["category","priority","recommended_scope","recommended_action","rationale","risks"]
};

const draftSchema={
  type:"object",additionalProperties:false,
  properties:{
    subject:{type:"string"},
    body:{type:"string"},
    strategy:{type:"string"},
    claims_used:{type:"array",items:{type:"string"}},
    claims_to_verify:{type:"array",items:{type:"string"}}
  },
  required:["subject","body","strategy","claims_used","claims_to_verify"]
};

Deno.serve(async(req:Request)=>{
  const url=new URL(req.url);
  const suffix=url.pathname.split("/authority-api")[1]||"/";
  if(req.method==="GET"&&suffix==="/healthz") return json({ok:true,service:"authority-api",ai:true});
  if(!(await authorised(req))) return json({error:"unauthorized"},401);

  try{
    if(req.method==="GET"&&suffix==="/dashboard"){
      const [{count:opp},{count:qualified},{count:pending},{count:inbound},{count:failures}]=await Promise.all([
        db.from("opportunities").select("*",{count:"exact",head:true}).eq("status","new"),
        db.from("opportunities").select("*",{count:"exact",head:true}).eq("status","qualified"),
        db.from("approvals").select("*",{count:"exact",head:true}).eq("status","pending"),
        db.from("inbound_enquiries").select("*",{count:"exact",head:true}).gte("priority",75),
        db.from("site_checks").select("*",{count:"exact",head:true}).eq("ok",false).gte("checked_at",new Date(Date.now()-86400000).toISOString())
      ]);
      return json({opportunities_new:opp??0,opportunities_qualified:qualified??0,approvals_pending:pending??0,high_priority_inbound:inbound??0,site_failures_24h:failures??0});
    }

    if(req.method==="GET"&&suffix==="/opportunities"){
      const limit=Math.max(1,Math.min(200,Number(url.searchParams.get("limit")||50)));
      let q=db.from("opportunities").select("*").order("score",{ascending:false}).order("created_at",{ascending:false}).limit(limit);
      const status=url.searchParams.get("status"); if(status) q=q.eq("status",status);
      const kind=url.searchParams.get("kind"); if(kind) q=q.eq("kind",kind);
      const {data,error}=await q; if(error) throw error;
      return json({items:data??[]});
    }

    if(req.method==="POST"&&suffix==="/inbound/classify"){
      const body=await req.json();
      if(!body?.message||typeof body.message!=="string") return json({error:"message required"},400);
      let a:any,mode="ai";
      try{
        a=await openaiStructured("inbound_classification",classificationSchema,
          "You are the private opportunity triage system for Martin Raeburn. Classify inbound enquiries conservatively. Prioritise speaking, credible media, partnerships, advisory/board opportunities and commercially serious work. Route subsidiary-specific work to the correct scope. Never invent facts. Return only the requested structured output.",
          {name:body.name??null,email:body.email??null,organization:body.organization??null,subject:body.subject??"",message:body.message});
      }catch(e){a=fallbackClassify(body.message,body.subject||"");a.risks=[e instanceof Error?e.message:"AI unavailable"];mode="fallback"}
      const {data,error}=await db.from("inbound_enquiries").insert({
        name:body.name??null,email:body.email??null,organization:body.organization??null,subject:body.subject??null,message:body.message,
        category:a.category,priority:a.priority,recommended_scope:a.recommended_scope,recommended_action:a.recommended_action,
        analysis:{mode,rationale:a.rationale,risks:a.risks??[]}
      }).select("id").single();
      if(error) throw error;
      await audit("inbound.classified","inbound",data.id,{priority:a.priority,category:a.category,mode});
      return json({id:data.id,...a,mode},201);
    }

    if(req.method==="POST"&&suffix==="/outreach/draft"){
      const body=await req.json();
      if(!body?.opportunity_id) return json({error:"opportunity_id required"},400);
      const {data:opportunity,error:oppError}=await db.from("opportunities").select("*").eq("id",body.opportunity_id).single();
      if(oppError||!opportunity) return json({error:"opportunity not found"},404);

      let contact:any=null;
      if(body.contact_id){
        const {data,error}=await db.from("contacts").select("*").eq("id",body.contact_id).single();
        if(error) return json({error:"contact not found"},404);
        contact=data;
      }
      const email=(body.email??contact?.email??"").toLowerCase();
      if(email){
        const {count}=await db.from("suppressions").select("*",{count:"exact",head:true}).eq("email",email);
        if((count??0)>0) return json({error:"recipient is suppressed"},409);
      }

      const draft=await openaiStructured("outreach_draft",draftSchema,
        "Draft concise, highly personalised professional outreach for Martin Raeburn. The aim is to earn a conversation or speaking/media opportunity, not to oversell. Use only facts present in the supplied opportunity/contact/context. Never invent achievements, clients, metrics, credentials, appearances or relationships. If a useful claim needs evidence, put it in claims_to_verify instead of using it. No hype. UK business tone. Return only structured output.",
        {opportunity,contact,email,context:body.context??null,desired_outcome:body.desired_outcome??"start a relevant conversation"});

      const {data:outreach,error}=await db.from("outreach").insert({
        opportunity_id:opportunity.id,contact_id:contact?.id??null,channel:"email",subject:draft.subject,body:draft.body,status:"draft"
      }).select("id").single();
      if(error) throw error;

      const {data:approval,error:approvalError}=await db.from("approvals").insert({
        action_type:"send_outreach",target_type:"outreach",target_id:outreach.id,status:"pending",
        reason:"AI-drafted external outreach requires human approval before sending."
      }).select("id").single();
      if(approvalError) throw approvalError;
      await audit("outreach.drafted","outreach",outreach.id,{opportunity_id:opportunity.id,approval_id:approval.id,claims_to_verify:draft.claims_to_verify});
      return json({outreach_id:outreach.id,approval_id:approval.id,...draft,status:"pending_approval"},201);
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