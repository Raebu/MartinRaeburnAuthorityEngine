import { buildApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db.js";

const app=await buildApp();

async function shutdown(signal:string) {
  app.log.info({signal},"shutting down");
  await app.close();
  await db.end();
  process.exit(0);
}

process.on("SIGTERM",()=>void shutdown("SIGTERM"));
process.on("SIGINT",()=>void shutdown("SIGINT"));

await app.listen({host:"0.0.0.0",port:config.PORT});
