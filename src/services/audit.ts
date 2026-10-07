import { sql } from "../db.js";

export async function audit(actor:string, action:string, entityType?:string, entityId?:string, details:Record<string,unknown>={}) {
  await sql("INSERT INTO audit_logs(actor,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)",
    [actor, action, entityType ?? null, entityId ?? null, JSON.stringify(details)]);
}
