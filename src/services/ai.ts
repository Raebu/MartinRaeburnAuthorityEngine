import { config } from "../config.js";

function extractText(payload:any):string {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output ?? []) for (const c of item?.content ?? []) {
    if (typeof c?.text === "string") return c.text;
  }
  throw new Error("AI response did not contain text");
}

export async function aiJson<T>(instructions:string, input:unknown):Promise<T|null> {
  if (!config.OPENAI_API_KEY) return null;
  const response = await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{
      "authorization":`Bearer ${config.OPENAI_API_KEY}`,
      "content-type":"application/json"
    },
    body:JSON.stringify({
      model:config.OPENAI_MODEL,
      instructions:`${instructions}\nReturn JSON only. Never invent credentials, achievements, clients, metrics, or factual claims.`,
      input:JSON.stringify(input)
    }),
    signal:AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`AI request failed: ${response.status}`);
  const text=extractText(await response.json()).trim().replace(/^\`\`\`json\s*/,"").replace(/\`\`\`$/,"");
  return JSON.parse(text) as T;
}
