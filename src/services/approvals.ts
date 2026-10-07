import { sql } from "../db.js";
import { audit } from "./audit.js";

export async function requestApproval(actionType:string,targetType:string,targetId:string,reason?:string) {
  const rows=await sql<{id:string}>(
    "INSERT INTO approvals(action_type,target_type,target_id,reason) VALUES($1,$2,$3,$4) RETURNING id",
    [actionType,targetType,targetId,reason??null]
  );
  await audit("system","approval.requested",targetType,targetId,{actionType});
  return rows[0]!.id;
}

export async function decideApproval(id:string,status:"approved"|"rejected",actor:string) {
  const rows=await sql<{target_type:string;target_id:string}>(
    `UPDATE approvals SET status=$2,decided_at=now(),decided_by=$3
     WHERE id=$1 AND status='pending' RETURNING target_type,target_id`,
    [id,status,actor]
  );
  if (!rows[0]) throw Object.assign(new Error("Approval not found or already decided"),{statusCode:404});
  await audit(actor,`approval.${status}`,rows[0].target_type,rows[0].target_id,{approvalId:id});
  return rows[0];
}
