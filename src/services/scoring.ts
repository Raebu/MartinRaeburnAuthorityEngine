export type OpportunityInput = {
  kind?: string;
  title?: string;
  summary?: string;
  deadline?: string | null;
  eventDate?: string | null;
  sourceName?: string;
};

const highFit = ["ai","automation","transformation","leadership","technology","recruitment","venture","entrepreneur","business","digital"];
const speaking = ["conference","summit","keynote","panel","speaker","webinar","roundtable","podcast","guest"];

export function scoreOpportunity(input:OpportunityInput) {
  const hay = [input.kind,input.title,input.summary,input.sourceName].filter(Boolean).join(" ").toLowerCase();
  let score = 25;
  score += Math.min(35, highFit.filter(k=>hay.includes(k)).length * 7);
  score += Math.min(20, speaking.filter(k=>hay.includes(k)).length * 5);
  if (input.deadline) {
    const days=(new Date(input.deadline).getTime()-Date.now())/86_400_000;
    if (days>=0 && days<=30) score += 10;
  }
  if (input.eventDate) {
    const days=(new Date(input.eventDate).getTime()-Date.now())/86_400_000;
    if (days>=14 && days<=240) score += 10;
  }
  return Math.max(0,Math.min(100,score));
}
