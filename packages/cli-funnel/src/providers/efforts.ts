import type { EffortOption } from "../types.js";

/**
 * The vendor `/models` endpoints say nothing about reasoning support, so the effort levels per model id live here.
 * The tables follow the vendor docs. A model that is missing gets no effort setting. A newer one still works with
 * `allowUnlistedModels`, which skips the per-model check and passes the effort string through.
 */

const levels = (...ids: string[]): EffortOption[] => ids.map((id) => ({ id, label: id === "xhigh" ? "Extra high" : id[0]!.toUpperCase() + id.slice(1) }));

const ANTHROPIC_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

interface AnthropicModel {
  family: string;
  /** Major and minor as one number, so 4.6 is 4.6 and 5.5 is 5.5. */
  version: number;
}

function parseAnthropic(id: string): AnthropicModel | undefined {
  const m = ANTHROPIC_ID.exec(id);
  return m ? { family: m[1]!, version: Number(m[2]) + Number(m[3] ?? 0) / 10 } : undefined;
}

/** Models that take `output_config.effort`: Opus 4.5 and later, Sonnet 4.6 and later, Haiku 5 and later, Fable and Mythos. */
function anthropicSupportsEffort(m: AnthropicModel): boolean {
  if (m.family === "opus") return m.version >= 4.5;
  if (m.family === "sonnet") return m.version >= 4.6;
  if (m.family === "haiku") return m.version >= 5;
  return true;
}

export function anthropicEfforts(id: string): EffortOption[] {
  const m = parseAnthropic(id);
  if (!m || !anthropicSupportsEffort(m)) return [];
  const out = ["low", "medium", "high"];
  if (!((m.family === "opus" && m.version < 4.7) || (m.family === "sonnet" && m.version < 5))) out.push("xhigh");
  if (!(m.family === "opus" && m.version < 4.6)) out.push("max");
  return levels(...out);
}

/** Opus 4.5 takes effort but only manual thinking budgets. Every other effort model takes adaptive thinking. */
export function anthropicAdaptive(id: string): boolean {
  const m = parseAnthropic(id);
  return !!m && anthropicSupportsEffort(m) && !(m.family === "opus" && m.version < 4.6);
}

/** Reasoning models: the o-series and GPT-5 onward. Chat and search variants take no `reasoning_effort`. */
export function openaiEfforts(id: string): EffortOption[] {
  if (!/^(o\d|gpt-[5-9])/.test(id) || /^o1-(mini|preview)|chat|search/.test(id)) return [];
  // GPT-5 pro reasons at high effort only.
  if (/^gpt-5(\.\d+)?-pro/.test(id)) return levels("high");
  return levels("low", "medium", "high");
}

/** Gemini 3 and later take `thinkingLevel`. Gemini 2.5 uses a token budget, which this package does not expose. */
export function geminiEfforts(id: string): EffortOption[] {
  if (!/^gemini-([3-9]|\d{2,})/.test(id)) return [];
  // Gemini 3 Pro has no medium level. Some Flash models also take `minimal`, which still works through `allowUnlistedModels`.
  if (/pro/.test(id)) return levels(...(id.startsWith("gemini-3-pro") ? ["low", "high"] : ["low", "medium", "high"]));
  return levels("low", "medium", "high");
}
