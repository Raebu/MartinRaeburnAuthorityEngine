import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, sql } from "./db.js";
import { requireApiKey } from "./auth.js";
import { aiJson } from "./services/ai.js";
import { listOpportunities } from "./services/opportunities.js";
import { requestApproval, decideApproval } from "./services/approvals.js";
import { sendEmail } from "./services/email.js";
import { audit } from "./services/audit.js";
import { runSiteMonitor } from "./jobs/site-monitor.js";
import { runDiscovery } from "./jobs/discovery.js";

export async function registerRoutes(app:FastifyInstance) {
  app.get("/healthz",async()=>({ok:true,service:"MartinRaeburnAuthorityEngine"}));
  app.get("/readyz",async(_req,reply)=>{
    try { await db.query("SELECT 1"); return {ok:true}; }
    catch { return reply.code(503).send({ok:false}); }
  });

  app.addHook("preHandler",async(req)=>{
    if (req.url.startsWith("/v1/")) await requireApiKey(req);
  });

  app.get("/v1/opportunities",async(req)=>{
    const q=z.object({status:z.string().optional(),limit:z.coerce.number().int().min(1).max(200).default(50)}).parse(req.query);
    return {items:await listOpportunities(q.limit,q.status)};
  });

  app.post("/v1/inbound/classify",async(req,reply)=>{
    const body=z.object({name:z.string().optional(),email:z.string().email().optional(),organization:z.string().optional(),subject:z.string().optional(),message:z.string().min(3)}).parse(req.body);
    const analysis=await aiJson<{category:string;priority:number;recommended_scope:string;recommended_action:string;reason:string}>(
      "Classify inbound contact for Martin Raeburn. category should be speaking, media, consulting, partnership, investment, recruitment, product, advisory, board, or general. Score priority 0-100. Do not infer sensitive personal data.",
      body
    );
    const a=analysis??{category:"general",priority:50,recommended_scope:"martin",recommended_action:"review manually",reason:"AI unavailable"};
    const rows=await sql<{id:string}>(
      `INSERT INTO inbound_enquiries(name,email,organization,subject,message,category,priority,recommended_scope,recommended_action,analysis)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id`,
      [body.name??null,body.email??null,body.organization??null,body.subject??null,body.message,a.category,Math.max(0,Math.min(100,a.priority)),a.recommended_scope,a.recommended_action,JSON.stringify(a)]
    );
    await audit("api","inbound.classified","inbound",rows[0]!.id,{priority:a.priority});
    return reply.code(201).send({id:rows[0]!.id,...a});
  });

  app.post("/v1/outreach/draft",async(req,reply)=>{
    const body=z.object({opportunity_id:z.string().uuid(),contact_id:z.string().uuid(),to:z.string().email(),contact_name:z.string().optional()}).parse(req.body);
    const opp=(await sql<any>("SELECT * FROM opportunities WHERE id=$1",[body.opportunity_id]))[0];
    if (!opp) return reply.code(404).send({error:"Opportunity not found"});
    const draft=await aiJson<{subject:string;body:string}>(
      "Draft a concise, highly personalised outreach email from Martin Raeburn. Use only supplied facts. No hype, no fabricated experience, no mass-mail language. The goal is a relevant conversation, speaking opportunity, media contribution, or strategic relationship as appropriate.",
      {opportunity:opp,contact_name:body.contact_name}
    );
    if (!draft) return reply.code(503).send({error:"AI is not configured"});
    const out=(await sql<{id:string}>("INSERT INTO outreach(opportunity_id,contact_id,subject,body) VALUES($1,$2,$3,$4) RETURNING id",[body.opportunity_id,body.contact_id,draft.subject,draft.body]))[0]!;
    const approvalId=await requestApproval("send_outreach","outreach",out.id,`Outbound email to ${body.to}`);
    await sql("UPDATE outreach SET status='awaiting_approval',updated_at=now() WHERE id=$1",[out.id]);
    return reply.code(201).send({outreach_id:out.id,approval_id:approvalId,subject:draft.subject,body:draft.body});
  });

  app.get("/v1/approvals",async()=>({items:await sql("SELECT * FROM approvals WHERE status='pending' ORDER BY requested_at ASC")}));

  app.post("/v1/approvals/:id/decision",async(req)=>{
    const params=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({decision:z.enum(["approved","rejected"]),actor:z.string().min(2)}).parse(req.body);
    return decideApproval(params.id,body.decision,body.actor);
  });

  app.post("/v1/outreach/:id/send",async(req,reply)=>{
    const params=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({to:z.string().email()}).parse(req.body);
    const suppressed=(await sql("SELECT 1 FROM suppressions WHERE lower(email)=lower($1) LIMIT 1",[body.to])).length>0;
    if (suppressed) return reply.code(409).send({error:"Recipient is suppressed"});
    const item=(await sql<any>(
      `SELECT o.*,
       EXISTS(SELECT 1 FROM approvals a WHERE a.target_type='outreach' AND a.target_id=o.id AND a.status='approved') AS approved
       FROM outreach o WHERE o.id=$1`,[params.id]))[0];
    if (!item) return reply.code(404).send({error:"Outreach not found"});
    if (!item.approved) return reply.code(409).send({error:"Approval required"});
    if (item.status==="sent") return reply.code(409).send({error:"Already sent"});
    const result=await sendEmail(body.to,item.subject??"Martin Raeburn",item.body.replace(/\n/g,"<br>"));
    await sql("UPDATE outreach SET status='sent',sent_at=now(),provider_message_id=$2,updated_at=now() WHERE id=$1",[params.id,result.id??null]);
    await audit("api","outreach.sent","outreach",params.id,{to:body.to});
    return {ok:true,id:result.id??null};
  });

  app.post("/v1/suppressions",async(req,reply)=>{
    const body=z.object({email:z.string().email(),reason:z.string().min(2),source:z.string().default("manual")}).parse(req.body);
    await sql("INSERT INTO suppressions(email,reason,source) VALUES($1,$2,$3) ON CONFLICT (lower(email)) DO UPDATE SET reason=EXCLUDED.reason,source=EXCLUDED.source",[body.email,body.reason,body.source]);
    return reply.code(201).send({ok:true});
  });

  app.get("/v1/dashboard/summary",async()=>{
    const [opp,approvals,inbound,checks]=await Promise.all([
      sql("SELECT status,count(*)::int AS count,max(score)::int AS max_score FROM opportunities GROUP BY status"),
      sql("SELECT count(*)::int AS pending FROM approvals WHERE status='pending'"),
      sql("SELECT count(*)::int AS high_priority FROM inbound_enquiries WHERE priority>=75 AND created_at>now()-interval '30 days'"),
      sql("SELECT count(*)::int AS failures FROM site_checks WHERE ok=false AND checked_at>now()-interval '24 hours'")
    ]);
    return {opportunities:opp,approvals:approvals[0],inbound:inbound[0],site:checks[0]};
  });

  app.post("/v1/jobs/site-monitor/run",async()=>({result:await runSiteMonitor()}));
  app.post("/v1/jobs/discovery/run",async()=>({result:await runDiscovery()}));
}
