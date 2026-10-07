import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;
export const db = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});

export async function sql<T=unknown>(text:string, params:unknown[]=[]):Promise<T[]> {
  const result = await db.query(text, params);
  return result.rows as T[];
}

export async function withAdvisoryLock<T>(key:number, fn:()=>Promise<T>):Promise<T|null> {
  const client = await db.connect();
  try {
    const lock = await client.query<{locked:boolean}>("SELECT pg_try_advisory_lock($1) AS locked",[key]);
    if (!lock.rows[0]?.locked) return null;
    try { return await fn(); }
    finally { await client.query("SELECT pg_advisory_unlock($1)",[key]); }
  } finally {
    client.release();
  }
}
