import { config } from "./config.js";
import { runDiscovery } from "./jobs/discovery.js";
import { runSiteMonitor } from "./jobs/site-monitor.js";
import { db } from "./db.js";

let stopping=false;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function loop(name:string,minutes:number,fn:()=>Promise<unknown>) {
  while(!stopping) {
    try { await fn(); } catch (error) { console.error(name,error); }
    await sleep(minutes*60_000);
  }
}

process.on("SIGTERM",()=>{stopping=true});
process.on("SIGINT",()=>{stopping=true});

await Promise.all([
  loop("site-monitor",config.SITE_MONITOR_INTERVAL_MINUTES,runSiteMonitor),
  loop("discovery",config.DISCOVERY_INTERVAL_MINUTES,runDiscovery)
]);

await db.end();
