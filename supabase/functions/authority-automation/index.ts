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
  const supplied=req.headers.get("x-job-key");
  if(!supplied)return false;
  const expected=await setting("job_key_sha256");
  return !!expected?.sha256&&(await sha256(supplied))===expected.sha256;
}
async function audit(action:string,entityType?:string,entityId?:string,details:Record<string,unknown>={}){
  await db.from("audit_logs").insert({
    actor:"authority-automation",
    action,
    entity_type:entityType??null,
    entity_id:entityId??null,
    details
  });
}
function extractText(payload:any){
  for(const item of payload?.output??[]){
    for(const c of item?.content??[]){
      if(c?.type==="output_text"&&typeof c.text==="string")return c.text;
    }
  }
  if(typeof payload?.output_text==="string")return payload.output_text;
  throw new Error("OpenAI response contained no output text");
}
async function openaiStructured(
  name:string,
  schema:any,
  instructions:string,
  input:any,
  useWeb=false
){
  const key=await secret("openai_api_key");
  const ai=await setting("ai_model");
  const model=ai?.model||"gpt-5.6-luna";
  const request:any={
    model,
    reasoning:{effort:"low"},
    store:false,
    instructions,
    input:JSON.stringify(input),
    text:{format:{type:"json_schema",name,strict:true,schema}}
  };
  if(useWeb)request.tools=[{type:"web_search"}];

  const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{"authorization":"Bearer "+key,"content-type":"application/json"},
    body:JSON.stringify(request),
    signal:AbortSignal.timeout(useWeb?60000:45000)
  });
  if(!response.ok)throw new Error("OpenAI "+response.status+": "+(await response.text()).slice(0,500));
  return JSON.parse(extractText(await response.json()));
}
function validEmail(value:string){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)&&value.length<=254;
}
function safePublicUrl(raw:string){
  try{
    const u=new URL(raw);
    if(u.protocol!=="https:"&&u.protocol!=="http:")return false;
    const h=u.hostname.toLowerCase();
    if(h==="localhost"||h.endsWith(".local")||h==="::1")return false;
    if(/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||/^169\.254\./.test(h))return false;
    const m=h.match(/^172\.(\d+)\./);
    if(m&&Number(m[1])>=16&&Number(m[1])<=31)return false;
    return true;
  }catch{return false}
}
async function sourceContainsEmail(sourceUrl:string,email:string){
  if(!safePublicUrl(sourceUrl))return false;
  const response=await fetch(sourceUrl,{
    redirect:"follow",
    signal:AbortSignal.timeout(15000),
    headers:{"user-agent":"MartinRaeburnAuthorityEngine/1.2"}
  });
  if(!response.ok)return false;
  const text=(await response.text()).toLowerCase();
  return text.includes(email.toLowerCase());
}
async function authorityApi(path:string,body:any){
  const key=await secret("authority_api_key");
  const response=await fetch(
    "https://pmymiwqrinhaxktfmlhm.supabase.co/functions/v1/authority-api"+path,
    {
      method:"POST",
      headers:{"content-type":"application/json","x-api-key":key},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(60000)
    }
  );
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error("Authority API "+response.status+": "+JSON.stringify(payload).slice(0,500));
  return payload;
}

const contactSchema={
  type:"object",
  additionalProperties:false,
  properties:{
    found:{type:"boolean"},
    person_name:{type:"string"},
    role:{type:"string"},
    organization:{type:"string"},
    email:{type:"string"},
    source_url:{type:"string"},
    confidence:{type:"number",minimum:0,maximum:1},
    rationale:{type:"string"}
  },
  required:["found","person_name","role","organization","email","source_url","confidence","rationale"]
};

async function runContactDiscovery(){
  const policy=await setting("contact_discovery_policy")??{
    enabled:true,max_per_run:5,min_confidence:0.82,require_public_professional_email:true,auto_prepare_first_contact:true
  };
  if(policy.enabled===false)return{disabled:true};

  const {data:run,error:runError}=await db.from("job_runs")
    .insert({job_name:"contact-discovery",status:"running"})
    .select("id").single();
  if(runError)throw runError;

  const {data:items,error}=await db.from("opportunities")
    .select("*")
    .eq("status","qualified")
    .not("source_url","is",null)
    .order("score",{ascending:false})
    .limit(Number(policy.max_per_run??5));
  if(error)throw error;

  let found=0,prepared=0,skipped=0,failed=0;

  for(const item of items??[]){
    try{
      const {count:existingOutreach,error:countError}=await db.from("outreach")
        .select("*",{count:"exact",head:true})
        .eq("opportunity_id",item.id);
      if(countError)throw countError;
      if((existingOutreach??0)>0){skipped++;continue}

      const result=await openaiStructured(
        "public_contact_discovery",
        contactSchema,
        `Find the best named public professional contact for this opportunity using web search.
The preferred person is the event programme lead, conference producer, speaker manager, podcast producer, journalist/editor, partnership lead or equivalent decision-maker.
Only return an email address that is visibly published on a public web page and is appropriate for professional contact.
Prefer a named individual's professional address. Do not guess email patterns, infer hidden emails, return personal/private addresses, use data brokers, or invent details.
source_url must be the exact public page where the returned email address is visible.
If no suitable named public professional email is found, set found=false and return empty strings for person_name, role, organization, email and source_url.
Do not use the opportunity source text as proof unless the email is actually present there.`,
        {
          title:item.title,
          kind:item.kind,
          organization:item.source_name,
          source_url:item.source_url,
          summary:item.summary,
          location:item.location,
          event_date:item.event_date,
          deadline:item.deadline
        },
        true
      );

      const email=String(result.email??"").trim().toLowerCase();
      const sourceUrl=String(result.source_url??"").trim();
      if(
        !result.found ||
        Number(result.confidence??0)<Number(policy.min_confidence??0.82) ||
        !validEmail(email) ||
        !sourceUrl ||
        !(await sourceContainsEmail(sourceUrl,email))
      ){
        await audit("contact.discovery_unverified","opportunity",item.id,{
          confidence:result.confidence??0,
          reason:result.rationale??"No verifiable public professional email"
        });
        skipped++;
        continue;
      }

      const {data:suppressed,error:suppressionError}=await db.from("suppressions")
        .select("id").ilike("email",email).limit(1).maybeSingle();
      if(suppressionError)throw suppressionError;
      if(suppressed){skipped++;continue}

      let organizationId:string|null=null;
      const organization=String(result.organization??"").trim();
      if(organization){
        const {data:existingOrg}=await db.from("organizations")
          .select("id").eq("name",organization).limit(1).maybeSingle();
        if(existingOrg?.id)organizationId=existingOrg.id;
        else{
          const {data:newOrg,error:orgError}=await db.from("organizations")
            .insert({name:organization,category:"authority-opportunity",metadata:{discovered_from:item.source_url}})
            .select("id").single();
          if(orgError)throw orgError;
          organizationId=newOrg.id;
        }
      }

      const {data:existingContact}=await db.from("contacts")
        .select("id").ilike("email",email).limit(1).maybeSingle();
      let contactId=existingContact?.id??null;
      if(!contactId){
        const {data:newContact,error:contactError}=await db.from("contacts")
          .insert({
            organization_id:organizationId,
            name:String(result.person_name||result.role||"Professional contact"),
            email,
            role:String(result.role??""),
            source_url:sourceUrl,
            metadata:{
              public_source_verified:true,
              confidence:result.confidence,
              rationale:result.rationale,
              opportunity_id:item.id
            }
          })
          .select("id").single();
        if(contactError)throw contactError;
        contactId=newContact.id;
      }

      found++;
      await audit("contact.discovered","contact",contactId,{
        opportunity_id:item.id,
        source_url:sourceUrl,
        confidence:result.confidence
      });

      if(policy.auto_prepare_first_contact!==false){
        await authorityApi("/outreach/draft",{
          opportunity_id:item.id,
          contact_id:contactId,
          email,
          context:{
            public_contact_source:sourceUrl,
            contact_role:result.role,
            contact_organization:organization,
            contact_discovery_rationale:result.rationale
          }
        });
        await db.from("opportunities")
          .update({status:"awaiting_approval",updated_at:new Date().toISOString()})
          .eq("id",item.id);
        prepared++;
      }
    }catch(e){
      failed++;
      await audit("contact.discovery_failed","opportunity",item.id,{
        error:e instanceof Error?e.message:String(e)
      });
    }
  }

  await db.from("job_runs").update({
    status:failed?"warning":"ok",
    finished_at:new Date().toISOString(),
    details:{processed:(items??[]).length,found,prepared,skipped,failed}
  }).eq("id",run.id);

  return{processed:(items??[]).length,found,prepared,skipped,failed};
}

const followupSchema={
  type:"object",
  additionalProperties:false,
  properties:{
    subject:{type:"string"},
    body:{type:"string"}
  },
  required:["subject","body"]
};

async function runFollowups(){
  const policy=await setting("followup_policy")??{
    enabled:true,max_per_run:5,max_followups:1,minimum_days_after_initial:7
  };
  if(policy.enabled===false)return{disabled:true};

  const {data:run,error:runError}=await db.from("job_runs")
    .insert({job_name:"followup-execution",status:"running"})
    .select("id").single();
  if(runError)throw runError;

  const {data:due,error}=await db.from("follow_ups")
    .select("*")
    .eq("status","pending")
    .lte("due_at",new Date().toISOString())
    .order("due_at",{ascending:true})
    .limit(Number(policy.max_per_run??5));
  if(error)throw error;

  let sent=0,stopped=0,failed=0;

  for(const task of due??[]){
    try{
      const {data:original,error:originalError}=await db.from("outreach")
        .select("*").eq("id",task.outreach_id).single();
      if(originalError||!original){stopped++;continue}

      if(original.status!=="sent"||original.reply_received_at){
        await db.from("follow_ups").update({
          status:"completed",
          completed_at:new Date().toISOString(),
          notes:"No follow-up sent because the original outreach is no longer eligible."
        }).eq("id",task.id);
        stopped++;
        continue;
      }

      const recipient=String(original.recipient_email??"").trim().toLowerCase();
      if(!validEmail(recipient)){stopped++;continue}

      const {data:suppressed,error:suppressionError}=await db.from("suppressions")
        .select("id").ilike("email",recipient).limit(1).maybeSingle();
      if(suppressionError)throw suppressionError;
      if(suppressed){
        await db.from("follow_ups").update({
          status:"completed",
          completed_at:new Date().toISOString(),
          notes:"No follow-up sent because recipient is suppressed."
        }).eq("id",task.id);
        stopped++;
        continue;
      }

      const {data:existingFollowup,error:followupCountError}=await db.from("outreach")
        .select("id").eq("parent_outreach_id",original.id).limit(1).maybeSingle();
      if(followupCountError)throw followupCountError;
      if(existingFollowup){
        await db.from("follow_ups").update({
          status:"completed",
          completed_at:new Date().toISOString(),
          notes:"Follow-up already exists for this outreach."
        }).eq("id",task.id);
        stopped++;
        continue;
      }

      const {data:opportunity}=original.opportunity_id
        ? await db.from("opportunities").select("*").eq("id",original.opportunity_id).maybeSingle()
        : {data:null};

      const draft=await openaiStructured(
        "single_professional_followup",
        followupSchema,
        `Write one short, polite professional follow-up to an earlier outreach from Martin Raeburn.
Do not add new claims, credentials, clients, achievements, metrics or urgency.
Do not pressure the recipient. Do not say "just following up" more than once.
Keep it under 110 words. Refer naturally to the original subject and the opportunity if relevant.
This is the only automatic follow-up; make it easy for the recipient to ignore or decline.`,
        {
          original_subject:original.subject,
          original_body:original.body,
          opportunity:opportunity??null
        },
        false
      );

      const subject=String(draft.subject||"").trim()||("Re: "+String(original.subject??""));
      const body=String(draft.body||"").trim();
      if(!body)throw new Error("empty follow-up draft");

      const {data:newOutreach,error:createError}=await db.from("outreach")
        .insert({
          opportunity_id:original.opportunity_id,
          contact_id:original.contact_id,
          channel:"email",
          recipient_email:recipient,
          subject,
          body,
          status:"draft",
          parent_outreach_id:original.id
        })
        .select("id").single();
      if(createError)throw createError;

      const {error:approvalError}=await db.from("approvals").insert({
        action_type:"send_outreach",
        target_type:"outreach",
        target_id:newOutreach.id,
        status:"approved",
        reason:"Single follow-up permitted automatically after a previously approved initial outreach.",
        decided_at:new Date().toISOString(),
        decided_by:"autonomous-followup-policy-v1"
      });
      if(approvalError)throw approvalError;

      await authorityApi("/outreach/"+newOutreach.id+"/send",{});

      await db.from("follow_ups").update({
        status:"completed",
        completed_at:new Date().toISOString(),
        notes:"Single automatic follow-up sent."
      }).eq("id",task.id);

      await audit("followup.sent","outreach",newOutreach.id,{
        parent_outreach_id:original.id,
        opportunity_id:original.opportunity_id
      });
      sent++;
    }catch(e){
      failed++;
      await audit("followup.failed","follow_up",task.id,{
        error:e instanceof Error?e.message:String(e)
      });
    }
  }

  await db.from("job_runs").update({
    status:failed?"warning":"ok",
    finished_at:new Date().toISOString(),
    details:{processed:(due??[]).length,sent,stopped,failed}
  }).eq("id",run.id);

  return{processed:(due??[]).length,sent,stopped,failed};
}

Deno.serve(async(req:Request)=>{
  if(req.method==="GET")return json({ok:true,service:"authority-automation"});
  if(req.method!=="POST")return json({error:"method not allowed"},405);
  if(!(await authorised(req)))return json({error:"unauthorized"},401);

  let body:any={};
  try{body=await req.json()}catch{}

  try{
    if(body.action==="contact-discovery")return json(await runContactDiscovery());
    if(body.action==="followups")return json(await runFollowups());
    return json({error:"unknown action"},400);
  }catch(e){
    return json({error:"automation failed",detail:e instanceof Error?e.message:String(e)},500);
  }
});
