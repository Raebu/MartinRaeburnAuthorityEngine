import { describe,expect,it } from "vitest";
import { scoreOpportunity } from "../src/services/scoring.js";

describe("scoreOpportunity",()=>{
  it("ranks relevant speaking opportunities above generic items",()=>{
    const relevant=scoreOpportunity({kind:"conference",title:"AI Automation Leadership Summit keynote speaker"});
    const generic=scoreOpportunity({kind:"listing",title:"General community notice"});
    expect(relevant).toBeGreaterThan(generic);
    expect(relevant).toBeLessThanOrEqual(100);
  });
});
