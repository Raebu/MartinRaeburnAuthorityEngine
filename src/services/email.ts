import { config } from "../config.js";

export async function sendEmail(to:string, subject:string, html:string) {
  if (!config.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const response = await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{
      authorization:`Bearer ${config.RESEND_API_KEY}`,
      "content-type":"application/json"
    },
    body:JSON.stringify({
      from:config.OUTREACH_FROM,
      to:[to],
      reply_to:config.OUTREACH_REPLY_TO,
      subject,
      html
    }),
    signal:AbortSignal.timeout(20_000)
  });
  const body=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(`Email provider failed: ${response.status}`);
  return body as {id?:string};
}
