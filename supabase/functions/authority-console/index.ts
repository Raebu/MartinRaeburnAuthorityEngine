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
  const supplied=req.headers.get("x-console-key");
  if(!supplied)return false;
  const expected=await setting("console_key_sha256");
  return !!expected?.sha256&&(await sha256(supplied))===expected.sha256;
}
async function authorityApi(path:string,body:any){
  const key=await secret("authority_api_key");
  const response=await fetch(
    "https://pmymiwqrinhaxktfmlhm.supabase.co/functions/v1/authority-api"+path,
    {
      method:"POST",
      headers:{"content-type":"application/json","x-api-key":key},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(30000)
    }
  );
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error("Authority API "+response.status+": "+JSON.stringify(payload).slice(0,400));
  return payload;
}

async function dashboardData(){
  const since24=new Date(Date.now()-86400000).toISOString();
  const since7=new Date(Date.now()-7*86400000).toISOString();

  const [
    oppNew,oppQualified,oppAwaiting,approvals,outreach,replies,siteFailures,
    opportunities,approvalRows,recentOutreach,jobs,site,searches,mentions,meetings,relationships,searchTotals
  ]=await Promise.all([
    db.from("opportunities").select("*",{count:"exact",head:true}).eq("status","new"),
    db.from("opportunities").select("*",{count:"exact",head:true}).eq("status","qualified"),
    db.from("opportunities").select("*",{count:"exact",head:true}).eq("status","awaiting_approval"),
    db.from("approvals").select("*",{count:"exact",head:true}).eq("status","pending"),
    db.from("outreach").select("*",{count:"exact",head:true}).eq("status","sent").gte("sent_at",since7),
    db.from("outreach").select("*",{count:"exact",head:true}).not("reply_received_at","is",null).gte("reply_received_at",since7),
    db.from("site_checks").select("*",{count:"exact",head:true}).eq("ok",false).gte("checked_at",since24),
    db.from("opportunities").select("id,kind,title,source_name,source_url,score,status,deadline,event_date,location,fit_reason,updated_at").in("status",["qualified","awaiting_approval","replied","review"]).order("score",{ascending:false}).limit(30),
    db.from("approvals").select("*").eq("status","pending").order("requested_at",{ascending:true}).limit(20),
    db.from("outreach").select("id,opportunity_id,contact_id,recipient_email,subject,status,sent_at,reply_received_at,last_delivery_event,provider_message_id,created_at").order("created_at",{ascending:false}).limit(30),
    db.from("job_runs").select("job_name,status,started_at,finished_at,details").order("id",{ascending:false}).limit(20),
    db.from("site_checks").select("url,status_code,ok,duration_ms,canonical,notes,checked_at").order("checked_at",{ascending:false}).limit(12),
    db.from("authority_search_queries").select("category,query,priority,last_run_at,enabled").eq("enabled",true).order("priority",{ascending:false}).limit(20),
    db.from("mentions").select("entity_name,source_title,source_domain,mention_type,has_link,target_url,authority_score,status,source_url,last_seen_at").order("authority_score",{ascending:false}).order("last_seen_at",{ascending:false}).limit(30),
    db.from("meeting_briefs").select("id,title,starts_at,attendees,status,brief,updated_at").order("starts_at",{ascending:true}).limit(12),
    db.from("contacts").select("id,name,email,role,metadata,organization_id").order("updated_at",{ascending:false}).limit(30),
    db.from("search_metrics").select("clicks,impressions,ctr,position,metric_date").gte("metric_date",new Date(Date.now()-28*86400000).toISOString().slice(0,10))
  ]);

  const approvalTargets=(approvalRows.data??[]).map((a:any)=>a.target_id).filter(Boolean);
  const {data:approvalOutreach}=approvalTargets.length
    ? await db.from("outreach").select("id,opportunity_id,recipient_email,subject,body,status").in("id",approvalTargets)
    : {data:[]};
  const oppIds=[...new Set((approvalOutreach??[]).map((o:any)=>o.opportunity_id).filter(Boolean))];
  const {data:approvalOpps}=oppIds.length
    ? await db.from("opportunities").select("id,title,kind,score,source_url,fit_reason").in("id",oppIds)
    : {data:[]};

  const outreachById=Object.fromEntries((approvalOutreach??[]).map((o:any)=>[o.id,o]));
  const oppById=Object.fromEntries((approvalOpps??[]).map((o:any)=>[o.id,o]));
  const pending=(approvalRows.data??[]).map((a:any)=>{
    const o=outreachById[a.target_id];
    return {...a,outreach:o??null,opportunity:o?oppById[o.opportunity_id]??null:null};
  });

  return {
    generated_at:new Date().toISOString(),
    summary:{
      opportunities_new:oppNew.count??0,
      opportunities_qualified:oppQualified.count??0,
      awaiting_approval:oppAwaiting.count??0,
      approvals_pending:approvals.count??0,
      emails_sent_7d:outreach.count??0,
      replies_7d:replies.count??0,
      site_failures_24h:siteFailures.count??0
    },
    opportunities:opportunities.data??[],
    approvals:pending,
    outreach:recentOutreach.data??[],
    jobs:jobs.data??[],
    site:site.data??[],
    searches:searches.data??[],
    mentions:mentions.data??[],
    meetings:meetings.data??[],
    relationships:(relationships.data??[]).map((x:any)=>({
      id:x.id,name:x.name,email:x.email,role:x.role,
      relationship_score:Number(x.metadata?.relationship_score??0),
      relationship_updated_at:x.metadata?.relationship_updated_at??null
    })).sort((a:any,b:any)=>b.relationship_score-a.relationship_score),
    search_summary:(searchTotals.data??[]).reduce((acc:any,row:any)=>{
      acc.clicks+=Number(row.clicks??0);
      acc.impressions+=Number(row.impressions??0);
      acc.positions.push(Number(row.position??0));
      return acc;
    },{clicks:0,impressions:0,positions:[]})
  };
}

const html=`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Martin Raeburn Authority Engine</title>
<style>
:root{color-scheme:dark;--bg:#0c1117;--panel:#141b24;--line:#263140;--text:#edf2f7;--muted:#97a6b8;--good:#5fd4a4;--warn:#f4c15d;--bad:#ff7a7a;--accent:#8db8ff}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:1440px;margin:auto;padding:26px}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:22px}
h1{font-size:24px;margin:0}.sub{color:var(--muted);margin-top:3px}.grid{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));gap:10px;margin:18px 0}
.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px}.card{padding:15px}.n{font-size:28px;font-weight:700}.label{color:var(--muted);font-size:12px}
.panel{padding:18px;margin:14px 0;overflow:auto}.panel h2{font-size:16px;margin:0 0 14px}
table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:12px}
a{color:var(--accent)}.score{font-weight:700}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}
button{background:#213047;color:white;border:1px solid #3a4e68;border-radius:8px;padding:8px 11px;cursor:pointer}button.primary{background:#235943;border-color:#34745a}button.danger{background:#562c32;border-color:#794049}
#login{max-width:430px;margin:14vh auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:25px}input{width:100%;padding:12px;border-radius:8px;border:1px solid var(--line);background:#0e151e;color:white;margin:12px 0}
.hidden{display:none}.body-preview{max-width:520px;white-space:pre-wrap;color:var(--muted);max-height:120px;overflow:auto}.pill{display:inline-block;padding:2px 7px;border-radius:999px;background:#202b38;color:#c9d5e3;font-size:11px}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.wrap{padding:14px}.top{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body>
<div id="login">
  <h1>Authority Engine</h1>
  <div class="sub">Private command centre</div>
  <input id="key" type="password" placeholder="Command-centre access key" autocomplete="current-password">
  <button class="primary" onclick="login()">Open command centre</button>
  <div id="loginerr" class="bad" style="margin-top:10px"></div>
</div>
<div id="app" class="wrap hidden">
  <div class="top"><div><h1>Martin Raeburn Authority Engine</h1><div class="sub" id="stamp"></div></div><button onclick="refresh()">Refresh</button></div>
  <div class="grid" id="summary"></div>
  <div class="panel"><h2>Needs Martin</h2><div id="approvals"></div></div>
  <div class="panel"><h2>Highest-value opportunities</h2><div id="opps"></div></div>
  <div class="panel"><h2>Recent outreach</h2><div id="outreach"></div></div>
  <div class="panel"><h2>Automation health</h2><div id="jobs"></div></div>
  <div class="panel"><h2>Website health</h2><div id="site"></div></div>
  <div class="panel"><h2>Mentions & backlink opportunities</h2><div id="mentions"></div></div>
  <div class="panel"><h2>Relationship intelligence</h2><div id="relationships"></div></div>
  <div class="panel"><h2>Meeting briefs</h2><div id="meetings"></div></div>
  <div class="panel"><h2>Search visibility</h2><div id="searchmetrics"></div></div>
  <div class="panel"><h2>Discovery coverage</h2><div id="searches"></div></div>
</div>
<script>
let K=sessionStorage.getItem("mra_console_key")||"";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
async function api(method="GET",body=null){
  const r=await fetch(location.pathname+"?api=1",{method,headers:{"x-console-key":K,"content-type":"application/json"},body:body?JSON.stringify(body):null});
  if(!r.ok)throw new Error((await r.text())||("HTTP "+r.status));
  return r.json();
}
async function login(){K=document.getElementById("key").value.trim();try{await refresh();sessionStorage.setItem("mra_console_key",K);document.getElementById("login").classList.add("hidden");document.getElementById("app").classList.remove("hidden")}catch(e){document.getElementById("loginerr").textContent="Access failed"}}
function table(headers,rows){return "<table><thead><tr>"+headers.map(h=>"<th>"+h+"</th>").join("")+"</tr></thead><tbody>"+rows.join("")+"</tbody></table>"}
async function act(action,id){if(!confirm(action==="approve_send"?"Approve and send this email now?":"Reject this outreach?"))return;await api("POST",{action,id});await refresh()}
async function refresh(){
  const d=await api();
  document.getElementById("stamp").textContent="Updated "+new Date(d.generated_at).toLocaleString();
  const S=d.summary;document.getElementById("summary").innerHTML=[
    ["New",S.opportunities_new],["Qualified",S.opportunities_qualified],["Needs approval",S.approvals_pending],
    ["Awaiting",S.awaiting_approval],["Sent 7d",S.emails_sent_7d],["Replies 7d",S.replies_7d],["Site failures",S.site_failures_24h]
  ].map(x=>'<div class="card"><div class="n">'+esc(x[1])+'</div><div class="label">'+esc(x[0])+'</div></div>').join("");

  document.getElementById("approvals").innerHTML=d.approvals.length?table(["Opportunity","Recipient","Subject / draft","Action"],d.approvals.map(a=>{
    const o=a.opportunity||{},x=a.outreach||{};
    return '<tr><td><b>'+esc(o.title||"Outreach")+'</b><br><span class="pill">'+esc(o.kind||"")+'</span> <span class="score">'+esc(o.score??"")+'</span></td><td>'+esc(x.recipient_email||"")+'</td><td><b>'+esc(x.subject||"")+'</b><div class="body-preview">'+esc(x.body||"")+'</div></td><td><button class="primary" onclick="act(\'approve_send\',\''+a.id+'\')">Approve & send</button> <button class="danger" onclick="act(\'reject\',\''+a.id+'\')">Reject</button></td></tr>'
  })):'<div class="good">Nothing currently requires approval.</div>';

  document.getElementById("opps").innerHTML=table(["Score","Type","Opportunity","Status","Deadline"],d.opportunities.map(o=>'<tr><td class="score">'+esc(o.score)+'</td><td>'+esc(o.kind)+'</td><td><a href="'+esc(o.source_url)+'" target="_blank" rel="noreferrer">'+esc(o.title)+'</a><br><span class="sub">'+esc(o.fit_reason||"")+'</span></td><td>'+esc(o.status)+'</td><td>'+esc(o.deadline?new Date(o.deadline).toLocaleDateString():"")+'</td></tr>'));
  document.getElementById("outreach").innerHTML=table(["Recipient","Subject","State","Sent / reply"],d.outreach.map(x=>'<tr><td>'+esc(x.recipient_email||"")+'</td><td>'+esc(x.subject||"")+'</td><td>'+esc(x.last_delivery_event||x.status)+'</td><td>'+esc(x.sent_at?new Date(x.sent_at).toLocaleString():"")+(x.reply_received_at?'<br><span class="good">Reply '+esc(new Date(x.reply_received_at).toLocaleString())+'</span>':"")+'</td></tr>'));
  document.getElementById("jobs").innerHTML=table(["Job","State","Finished","Details"],d.jobs.map(j=>'<tr><td>'+esc(j.job_name)+'</td><td class="'+(j.status==="ok"?"good":j.status==="warning"?"warn":"")+'">'+esc(j.status)+'</td><td>'+esc(j.finished_at?new Date(j.finished_at).toLocaleString():"running")+'</td><td><code>'+esc(JSON.stringify(j.details||{}))+'</code></td></tr>'));
  document.getElementById("site").innerHTML=table(["URL","HTTP","State","ms"],d.site.map(s=>'<tr><td>'+esc(s.url)+'</td><td>'+esc(s.status_code??"")+'</td><td class="'+(s.ok?"good":"bad")+'">'+(s.ok?"OK":"FAIL")+'</td><td>'+esc(s.duration_ms??"")+'</td></tr>'));
  document.getElementById("mentions").innerHTML=d.mentions.length?table(["Score","Mention","Domain","Link"],d.mentions.map(m=>'<tr><td class="score">'+esc(m.authority_score??"")+'</td><td><a href="'+esc(m.source_url)+'" target="_blank" rel="noreferrer">'+esc(m.source_title||m.source_url)+'</a><br><span class="pill">'+esc(m.mention_type)+'</span></td><td>'+esc(m.source_domain||"")+'</td><td class="'+(m.has_link?"good":"warn")+'">'+(m.has_link?"Linked":"Unlinked")+'</td></tr>')):'<div class="sub">No monitored mentions yet.</div>';
  document.getElementById("relationships").innerHTML=d.relationships.length?table(["Score","Contact","Role","Email"],d.relationships.slice(0,20).map(r=>'<tr><td class="score">'+esc(r.relationship_score)+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.role||"")+'</td><td>'+esc(r.email||"")+'</td></tr>')):'<div class="sub">Relationship scores will appear as conversations develop.</div>';
  document.getElementById("meetings").innerHTML=d.meetings.length?table(["When","Meeting","Status","Objective"],d.meetings.map(m=>'<tr><td>'+esc(m.starts_at?new Date(m.starts_at).toLocaleString():"")+'</td><td>'+esc(m.title)+'</td><td>'+esc(m.status)+'</td><td>'+esc(m.brief?.objective||"")+'</td></tr>')):'<div class="sub">No meeting briefs prepared yet.</div>';
  const sm=d.search_summary||{clicks:0,impressions:0,positions:[]}; const avg=sm.positions?.length?(sm.positions.reduce((a,b)=>a+b,0)/sm.positions.length).toFixed(1):"—";
  document.getElementById("searchmetrics").innerHTML='<div class="grid" style="grid-template-columns:repeat(3,minmax(120px,1fr));margin:0"><div class="card"><div class="n">'+esc(sm.clicks)+'</div><div class="label">Clicks / 28d</div></div><div class="card"><div class="n">'+esc(sm.impressions)+'</div><div class="label">Impressions / 28d</div></div><div class="card"><div class="n">'+esc(avg)+'</div><div class="label">Avg position</div></div></div>';
  document.getElementById("searches").innerHTML=table(["Category","Query","Priority","Last run"],d.searches.map(s=>'<tr><td>'+esc(s.category)+'</td><td>'+esc(s.query)+'</td><td>'+esc(s.priority)+'</td><td>'+esc(s.last_run_at?new Date(s.last_run_at).toLocaleString():"Never")+'</td></tr>'));
}
if(K){login()}
</script>
</body>
</html>`;

Deno.serve(async(req:Request)=>{
  const url=new URL(req.url);
  if(url.searchParams.get("api")!=="1"){
    return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-frame-options":"DENY","content-security-policy":"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"}});
  }

  if(!(await authorised(req)))return json({error:"unauthorized"},401);

  if(req.method==="GET")return json(await dashboardData());

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const action=body?.action;
    const id=String(body?.id??"");
    if(!id)return json({error:"id required"},400);

    const {data:approval,error}=await db.from("approvals")
      .select("*").eq("id",id).eq("status","pending").maybeSingle();
    if(error)throw error;
    if(!approval)return json({error:"approval not found or already decided"},404);

    if(action==="reject"){
      const {error:updateError}=await db.from("approvals").update({
        status:"rejected",decided_at:new Date().toISOString(),decided_by:"command-centre"
      }).eq("id",id).eq("status","pending");
      if(updateError)throw updateError;
      return json({ok:true});
    }

    if(action==="approve_send"){
      const {error:updateError}=await db.from("approvals").update({
        status:"approved",decided_at:new Date().toISOString(),decided_by:"command-centre"
      }).eq("id",id).eq("status","pending");
      if(updateError)throw updateError;
      try{
        const result=await authorityApi("/outreach/"+approval.target_id+"/send",{});
        return json({ok:true,result});
      }catch(e){
        await db.from("approvals").update({
          status:"pending",decided_at:null,decided_by:null
        }).eq("id",id).eq("status","approved");
        throw e;
      }
    }
    return json({error:"unknown action"},400);
  }

  return json({error:"method not allowed"},405);
});
