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

async function secret(name:string){
  const {data,error}=await db.rpc("vault_read_secret",{secret_name:name});
  if(error||!data)throw new Error("missing secret "+name);
  return String(data);
}

function extractEmail(value:unknown){
  const raw=Array.isArray(value)?String(value[0]??""):String(value??"");
  const match=raw.match(/<([^>]+)>/);
  return (match?.[1]??raw).trim().toLowerCase();
}

function safeEqual(a:string,b:string){
  if(a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

async function verifyWebhook(raw:string,headers:Headers){
  const webhookSecret=await secret("resend_webhook_secret");
  const id=headers.get("svix-id");
  const timestamp=headers.get("svix-timestamp");
  const signature=headers.get("svix-signature");
  if(!id||!timestamp||!signature)return false;

  const seconds=Number(timestamp);
  if(!Number.isFinite(seconds)||Math.abs(Date.now()/1000-seconds)>300)return false;

  const secretPart=webhookSecret.startsWith("whsec_")
    ? webhookSecret.slice(6)
    : webhookSecret;
  let keyBytes:Uint8Array;
  try{
    keyBytes=Uint8Array.from(atob(secretPart),c=>c.charCodeAt(0));
  }catch{
    keyBytes=new TextEncoder().encode(secretPart);
  }

  const key=await crypto.subtle.importKey(
    "raw",keyBytes,{name:"HMAC",hash:"SHA-256"},false,["sign"]
  );
  const signed=`${id}.${timestamp}.${raw}`;
  const mac=new Uint8Array(
    await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(signed))
  );
  const expected=btoa(String.fromCharCode(...mac));

  return signature.split(" ").some(part=>{
    const [version,value]=part.split(",");
    return version==="v1"&&typeof value==="string"&&safeEqual(value,expected);
  });
}

async function audit(action:string,entityType?:string,entityId?:string,details:Record<string,unknown>={}){
  await db.from("audit_logs").insert({
    actor:"resend-webhook",
    action,
    entity_type:entityType??null,
    entity_id:entityId??null,
    details
  });
}

async function findOutreachByProvider(providerMessageId?:string){
  if(!providerMessageId)return null;
  const {data}=await db.from("outreach")
    .select("*")
    .eq("provider_message_id",providerMessageId)
    .order("created_at",{ascending:false})
    .limit(1)
    .maybeSingle();
  return data??null;
}

async function findRecentOutreachByRecipient(recipient?:string){
  if(!recipient)return null;
  const {data}=await db.from("outreach")
    .select("*")
    .ilike("recipient_email",recipient)
    .eq("status","sent")
    .order("sent_at",{ascending:false})
    .limit(1)
    .maybeSingle();
  return data??null;
}

async function storeEvent(event:any,raw:string,headers:Headers){
  const data=event?.data??{};
  const providerMessageId=String(data?.email_id??data?.id??"")||null;
  const recipient=extractEmail(data?.to);
  const sender=extractEmail(data?.from);
  const providerEventId=headers.get("svix-id");

  if(!providerEventId)return;
  await db.from("email_events").upsert({
    provider_event_id:providerEventId,
    provider_message_id:providerMessageId,
    event_type:String(event?.type??"unknown"),
    recipient_email:recipient||null,
    sender_email:sender||null,
    subject:data?.subject??null,
    payload:event,
    occurred_at:event?.created_at??new Date().toISOString()
  },{onConflict:"provider_event_id"});
}

async function stopFollowups(outreachId:string,note:string){
  await db.from("follow_ups").update({
    status:"completed",
    completed_at:new Date().toISOString(),
    notes:note
  }).eq("outreach_id",outreachId).eq("status","pending");
}

Deno.serve(async(req:Request)=>{
  if(req.method==="GET")return json({ok:true,service:"authority-events"});
  if(req.method!=="POST")return json({error:"method not allowed"},405);

  const raw=await req.text();
  let verified=false;
  try{verified=await verifyWebhook(raw,req.headers)}catch{}
  if(!verified)return json({error:"invalid webhook signature"},401);

  let event:any;
  try{event=JSON.parse(raw)}catch{return json({error:"invalid json"},400)}

  const type=String(event?.type??"unknown");
  const data=event?.data??{};
  const providerMessageId=String(data?.email_id??data?.id??"")||undefined;
  const recipient=extractEmail(data?.to);
  const sender=extractEmail(data?.from);

  await storeEvent(event,raw,req.headers);

  if(type==="email.delivered"){
    const outreach=await findOutreachByProvider(providerMessageId);
    if(outreach){
      await db.from("outreach").update({
        last_delivery_event:"delivered",
        last_delivery_at:new Date().toISOString(),
        updated_at:new Date().toISOString()
      }).eq("id",outreach.id);
      await audit("email.delivered","outreach",outreach.id,{recipient});
    }
  }

  if(type==="email.received"){
    const outreach=await findRecentOutreachByRecipient(sender);
    if(outreach){
      await db.from("outreach").update({
        reply_received_at:new Date().toISOString(),
        last_delivery_event:"replied",
        last_delivery_at:new Date().toISOString(),
        updated_at:new Date().toISOString()
      }).eq("id",outreach.id);

      await stopFollowups(
        outreach.id,
        "Stopped automatically because a reply was received."
      );

      if(outreach.opportunity_id){
        await db.from("opportunities").update({
          status:"replied",
          updated_at:new Date().toISOString()
        }).eq("id",outreach.opportunity_id);
      }

      await audit("reply.received","outreach",outreach.id,{
        sender,
        recipient,
        subject:data?.subject??null
      });
    }else{
      await audit("inbound.unmatched","email",providerMessageId,{
        sender,
        recipient,
        subject:data?.subject??null
      });
    }
  }

  if(["email.bounced","email.complained","email.suppressed","email.failed"].includes(type)){
    const reason=type.replace("email.","");
    const outreach=
      await findOutreachByProvider(providerMessageId) ??
      await findRecentOutreachByRecipient(recipient);

    if(recipient){
      await db.from("suppressions").upsert({
        email:recipient.toLowerCase(),
        reason:`Resend ${reason}`,
        source:"resend-webhook"
      },{onConflict:"email"});
    }

    if(outreach){
      await db.from("outreach").update({
        status:reason,
        last_delivery_event:reason,
        last_delivery_at:new Date().toISOString(),
        last_error:JSON.stringify(data).slice(0,1000),
        updated_at:new Date().toISOString()
      }).eq("id",outreach.id);

      await stopFollowups(
        outreach.id,
        `Stopped automatically after ${reason} event.`
      );

      if(outreach.opportunity_id){
        await db.from("opportunities").update({
          status:"delivery_issue",
          updated_at:new Date().toISOString()
        }).eq("id",outreach.opportunity_id);
      }

      await audit(`email.${reason}`,"outreach",outreach.id,{recipient});
    }
  }

  return json({ok:true});
});
