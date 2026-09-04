export interface UsageMetricEntry {
  id: string;
  name: string;
  category: string;
  costUsd: number;
}

export function sumAgentUsageMetrics(metrics: unknown): number {
  if (!Array.isArray(metrics)) return 0;
  return metrics.reduce((sum, value) => {
    if (!value || typeof value !== "object") return sum;
    const metric = value as Record<string, unknown>;
    const id = String(metric["id"] ?? "").toLowerCase();
    const name = String(metric["name"] ?? "").toLowerCase();
    const category = String(metric["category"] ?? "").toLowerCase();
    const costUsd = Number(metric["costUsd"] ?? 0);
    const isAgent = id.includes("ai_agent") ||
      id.includes("ai-agent") ||
      (category === "ai" && name.includes("agent"));
    return isAgent && Number.isFinite(costUsd) ? sum + costUsd : sum;
  }, 0);
}