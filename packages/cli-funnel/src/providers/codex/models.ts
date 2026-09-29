import type { ModelInfo } from "../../types.js";

interface CatalogModel {
  slug: string;
  display_name: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: { effort: string }[];
  visibility?: string;
  additional_speed_tiers?: string[];
  service_tiers?: { id: string }[];
}

const LABELS: Record<string, string> = { xhigh: "Extra high" };
const label = (id: string) => LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/** Parses `codex debug models` output. Hidden models are skipped. */
export function parseCatalog(json: string): ModelInfo[] {
  const data = JSON.parse(json) as { models?: CatalogModel[] };
  return (data.models ?? [])
    .filter((m) => m.visibility === "list")
    .map((m) => ({
      id: m.slug,
      name: m.display_name,
      provider: "codex" as const,
      efforts: (m.supported_reasoning_levels ?? []).map((l) => ({ id: l.effort, label: label(l.effort) })),
      defaultEffort: m.default_reasoning_level,
      contextWindows: [],
      fast: !!m.additional_speed_tiers?.includes("fast") || !!m.service_tiers?.some((t) => t.id === "priority"),
      source: "cli" as const,
    }));
}
