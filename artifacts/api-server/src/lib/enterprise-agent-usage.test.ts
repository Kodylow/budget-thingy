import { describe, expect, it } from "vitest";
import { sumAgentUsageMetrics } from "./enterprise";

describe("workspace Agent usage", () => {
  it("includes only Agent metrics and excludes other AI and non-AI spend", () => {
    expect(sumAgentUsageMetrics([
      {
        id: "replit:v0:teams:ai_agent",
        name: "Agent",
        category: "ai",
        costUsd: 12.5,
      },
      {
        id: "replit:v0:teams:assistant",
        name: "Assistant",
        category: "ai",
        costUsd: 90,
      },
      {
        id: "compute",
        name: "Compute",
        category: "hosting",
        costUsd: 40,
      },
    ])).toBe(12.5);
  });

  it("recognizes an Agent name only within the AI category", () => {
    expect(sumAgentUsageMetrics([
      { id: "beta", name: "AI Agent", category: "ai", costUsd: 7 },
      { id: "support", name: "Support agent", category: "service", costUsd: 99 },
    ])).toBe(7);
  });
});