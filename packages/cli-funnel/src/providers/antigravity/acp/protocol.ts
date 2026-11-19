import { FunnelError, type AccessLevel, type FunnelEvent, type Limit, type PlanStep, type Usage } from "../../../types.js";
import { parseDuration } from "../../limits.js";
import { createMapper, parseModels } from "../parser.js";
import type { ModelInfo } from "../../../types.js";

/**
 * The pure half of the Antigravity ACP transport: message shapes, config options, session updates and failures. Nothing
 * here starts a process or reads a file, so each function is tested against recorded `agy acp` output.
 */

type Json = Record<string, any>;

/** The oldest `agy` whose `acp` server this transport was written against. Older builds list fewer models and no thinking level. */
export const ACP_MIN_VERSION = "1.5.0";

/** ACP protocol version 1. `agy acp` answers it with its own `protocolVersion: 1`. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * What cli-funnel tells the agent it can do for it. Nothing: `agy` reads and writes files and runs commands itself,
 * and advertising `fs` or `terminal` would hand those jobs to the client. Writes in particular would swap agy's own
 * diff edits for whole-file client edits.
 */
export function initializeParams(version: string): Json {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "cli-funnel", title: "cli-funnel", version },
  };
}

/** What `initialize` told about the agent, reduced to what the transport uses. */
export interface AgentFacts {
  version?: string;
  /** `session/resume` is advertised. */
  resume: boolean;
  /** `session/load` is advertised. */
  load: boolean;
  /** The agent takes `_meta.antigravity.systemPrompt.append` on `session/new` and `session/resume`. */
  systemPrompt: boolean;
  /** Prompt content blocks the agent takes. */
  images: boolean;
}

export function agentFacts(result: Json | undefined): AgentFacts {
  const caps = result?.agentCapabilities ?? {};
  const sessions = caps.sessionCapabilities ?? caps.session_capabilities ?? {};
  return {
    version: typeof result?.agentInfo?.version === "string" ? result.agentInfo.version : undefined,
    resume: sessions.resume !== undefined && sessions.resume !== null,
    load: caps.loadSession === true || caps.load_session === true || (sessions.load !== undefined && sessions.load !== null),
    systemPrompt: caps._meta?.antigravity?.systemPrompt?.append === true,
    images: caps.promptCapabilities?.image === true,
  };
}

/** `_meta` for `session/new` and `session/resume`. The system prompt is not kept between processes, so every activation sends it. */
export function sessionMeta(system: string | undefined, facts: AgentFacts): Json | undefined {
  return system !== undefined && facts.systemPrompt ? { antigravity: { systemPrompt: { append: system } } } : undefined;
}

export interface ConfigOption {
  id: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: { value: string; name?: string }[];
}

const asOptions = (value: unknown): ConfigOption[] => (Array.isArray(value) ? (value as ConfigOption[]).filter((o) => o && typeof o === "object") : []);

/** The select option with this id, from the `configOptions` of a `session/new`, `session/resume` or `session/set_config_option` answer. */
export function findOption(configOptions: unknown, test: (o: ConfigOption) => boolean): ConfigOption | undefined {
  return asOptions(configOptions).find((o) => (o.type === undefined || o.type === "select") && test(o));
}

const optionValues = (o: ConfigOption | undefined): string[] => (o?.options ?? []).flatMap((x) => (typeof x?.value === "string" ? [x.value] : []));

/** The model ids of the account, as the session's `model` option lists them. Entries with a thinking level in the id stay whole. */
export const modelValues = (configOptions: unknown): string[] => optionValues(findOption(configOptions, (o) => o.id === "model" || o.category === "model"));

/** The thinking levels of the current model. */
export const thoughtLevels = (configOptions: unknown): string[] => optionValues(findOption(configOptions, (o) => o.category === "thought_level"));

/** The `currentValue` of the `model` option. */
export const currentModel = (configOptions: unknown): string | undefined => findOption(configOptions, (o) => o.id === "model" || o.category === "model")?.currentValue;

/** The `currentValue` of the thinking level option. */
export const currentThought = (configOptions: unknown): string | undefined => findOption(configOptions, (o) => o.category === "thought_level")?.currentValue;

const EFFORT_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/;

/**
 * What to set on a session so it runs `model` at `effort`. `model` is the id of a family (`gemini-3.8-flash`) or an id
 * from the account's list as it is (`gpt-oss-120b-medium`). A 1.3-style id with the level in it (`gemini-3.8-flash-high`)
 * is read as the family and a level. Fails with `invalid-selection` when the account does not list the model.
 */
export function planModel(configOptions: unknown, model: string, effort: string | undefined): { model: string; thought?: string } {
  const values = modelValues(configOptions);
  if (values.includes(model)) return { model, ...(effort ? { thought: effort } : {}) };
  const legacy = EFFORT_SUFFIX.exec(model);
  if (legacy && values.includes(legacy[1]!)) return { model: legacy[1]!, thought: effort ?? legacy[2] };
  throw new FunnelError(
    `Antigravity does not offer "${model}" to this Google account.${values.length ? ` It offers: ${values.join(", ")}.` : ""}`,
    "invalid-selection",
  );
}

/** Throws `invalid-selection` when the current model has no such thinking level. Models without a thinking option take none. */
export function checkThought(configOptions: unknown, model: string, thought: string): void {
  const levels = thoughtLevels(configOptions);
  if (levels.length && !levels.includes(thought)) {
    throw new FunnelError(`${model} has no thinking level "${thought}". It has: ${levels.join(", ")}.`, "invalid-selection");
  }
}

/** The account's models from `session/new`'s `models.availableModels`, grouped by family the way `agy models` output is. */
export function modelsFromSession(models: Json | undefined): ModelInfo[] {
  const list: Json[] = Array.isArray(models?.availableModels) ? models.availableModels : [];
  return parseModels(list.flatMap((m) => (typeof m?.modelId === "string" && typeof m?.name === "string" ? [`${m.modelId}\t${m.name}`] : [])).join("\n"));
}

/** `session/prompt` content blocks for the run: the text, then the images. */
export function promptBlocks(text: string, images: { mediaType: string; data: string }[] | undefined): Json[] {
  return [{ type: "text", text }, ...(images ?? []).map((a) => ({ type: "image", data: a.data, mimeType: a.mediaType }))];
}

/**
 * The `usage` of a `session/prompt` result. agy leaves the cache out of `inputTokens` (its own `totalTokens` is the sum of
 * input, output and cache read), so the cache read and write are added here, and `cachedInputTokens` is the read part.
 * That is the convention of every provider. Thinking tokens are in `outputTokens` already.
 */
export function toUsage(u: Json | undefined): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const read = Number(u.cachedReadTokens) || 0;
  const written = Number(u.cachedWriteTokens) || 0;
  const input = (Number(u.inputTokens) || 0) + read + written;
  const output = Number(u.outputTokens) || 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: read || undefined,
    cacheCreationInputTokens: written || undefined,
    reasoningTokens: Number(u.thoughtTokens) || undefined,
    totalTokens: input + output,
  };
}

/**
 * The answer to a `session/request_permission`: the reject option. At `none` and above, cli-funnel approves nothing
 * on this transport, because ACP has no way to show an approval to the caller's `onApproval` yet.
 */
export function denyPermission(params: Json | undefined): Json {
  const options: Json[] = Array.isArray(params?.options) ? params.options : [];
  const reject = options.find((o) => o?.kind === "reject_once") ?? options.find((o) => o?.kind === "reject_always");
  return reject && typeof reject.optionId === "string" ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
}

const MAX_TOOL_OUTPUT = 8_000;

/** The text of a tool's result: `rawOutput.output`, else the text blocks of `content`. Cut at 8,000 characters. */
export function toolOutput(update: Json): string | undefined {
  const raw = update.rawOutput;
  let text: string | undefined;
  if (typeof raw === "string") text = raw;
  else if (typeof raw?.output === "string") text = raw.output;
  else if (Array.isArray(update.content)) {
    const parts = update.content.flatMap((c: Json) => (c?.content?.type === "text" && typeof c.content.text === "string" ? [c.content.text] : []));
    text = parts.length ? parts.join("\n") : undefined;
  }
  if (!text) return undefined;
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n[cut at ${MAX_TOOL_OUTPUT} characters]` : text;
}

const PLAN_STATUS: Record<string, PlanStep["status"]> = { pending: "pending", in_progress: "in_progress", completed: "done" };

/** The steps of an ACP `plan` update. */
export function planSteps(update: Json): PlanStep[] {
  const entries: Json[] = Array.isArray(update.entries) ? update.entries : [];
  return entries.flatMap((e) => (typeof e?.content === "string" && e.content.trim() ? [{ text: e.content.trim(), status: PLAN_STATUS[String(e.status)] ?? "pending" }] : []));
}

export interface AcpMapperOptions {
  access: AccessLevel;
  /** For the `file.change` events of the write tools. See `MapperOptions` of the print parser. */
  cwd?: string;
  createdInRun?: (path: string) => boolean | undefined;
  brainDir?: string;
  readText?: (path: string) => string | undefined;
}

/** What `none`'s hook says when it refuses a tool call. The tool then ends as `failed` with no text. */
const HOOK_MESSAGE = "denied by pre-tool hook: Tools are disabled. Answer in text only.";

/** The message of a refused tool call that we denied through `session/request_permission`. */
export const PERMISSION_DENIED = "denied permission: cli-funnel does not approve tool calls on this transport.";

/**
 * Turns the `session/update` notifications of one session into events. Tool calls go through the print transport's
 * mapper, which already knows agy's tool names and turns them into `file.change` and `plan` events: an ACP tool update
 * carries the same `name` and arguments as agy's `step_update` line, so it is rebuilt as one.
 */
export function createAcpMapper(sessionId: string, options: AcpMapperOptions) {
  const tools = createMapper({ access: options.access, brainDir: options.brainDir, readText: options.readText, createdInRun: options.createdInRun });
  if (options.cwd) tools.map({ event: "init", conversation_id: sessionId, init: { cwd: options.cwd } });
  const refused = new Set<string>();
  const ended = new Set<string>();
  // The final message is the text after the last tool call, as in the print transport.
  let message = "";
  let denied = 0;
  let plan = "";

  function tool(update: Json): FunnelEvent[] {
    const id = String(update.toolCallId ?? "");
    if (!id) return [];
    const status = String(update.status ?? "");
    const state = status === "completed" ? "DONE" : status === "failed" ? "ERROR" : "RUNNING";
    if (state !== "RUNNING" && ended.has(id)) return [];
    const name = typeof update.name === "string" && update.name ? update.name : typeof update.kind === "string" ? update.kind : "tool";
    const output = toolOutput(update);
    let error: { message: string } | undefined;
    if (state === "ERROR") {
      const given = output?.split("\n")[0];
      const text = refused.has(id) ? PERMISSION_DENIED : given || (options.access === "none" ? HOOK_MESSAGE : "tool failed");
      error = { message: text };
    }
    const events = tools.map({
      event: "step_update",
      step_update: {
        step_type: "tool",
        conversation_id: sessionId,
        step_index: id,
        tool_name: name,
        state,
        tool_info: { name, parameters: update.rawInput ?? update.args, ...(error ? { error } : {}), ...(state === "DONE" && output !== undefined ? { output } : {}) },
      },
    });
    if (state !== "RUNNING") ended.add(id);
    return events.map((e) => {
      if (e.type === "tool.end" && !e.error && output !== undefined) return { ...e, output };
      if (e.type === "tool.end" && e.error?.startsWith("denied:")) denied++;
      return e;
    });
  }

  return {
    /** Marks a tool call whose permission request was refused, so its failure reads as a denial. */
    refuse(toolCallId: string): void {
      refused.add(toolCallId);
    },
    update(update: Json): FunnelEvent[] {
      switch (update?.sessionUpdate) {
        case "agent_message_chunk": {
          const text = update.content?.type === "text" ? update.content.text : undefined;
          if (typeof text !== "string" || !text) return [];
          message += text;
          return [{ type: "text.delta", text }];
        }
        case "agent_thought_chunk": {
          const text = update.content?.type === "text" ? update.content.text : undefined;
          return typeof text === "string" && text ? [{ type: "reasoning.delta", text }] : [];
        }
        case "tool_call":
          message = "";
          return tool(update);
        case "tool_call_update":
          return tool(update);
        case "plan": {
          const steps = planSteps(update);
          const key = JSON.stringify(steps);
          if (!steps.length || key === plan) return [];
          plan = key;
          return [{ type: "plan", steps }];
        }
        default:
          return [];
      }
    },
    /** The events that end a turn that stopped for `stopReason`. */
    finish(stopReason: string, usage: Json | undefined): FunnelEvent[] {
      const events: FunnelEvent[] = [];
      const u = toUsage(usage);
      if (u) events.push({ type: "usage", usage: u });
      const text = message;
      if (stopReason === "cancelled") events.push({ type: "done", text: "", finishReason: "cancelled" });
      else events.push({ type: "done", text, finishReason: stopReason === "max_tokens" ? "length" : denied && !text.trim() ? "denied" : "stop" });
      return events;
    },
    /** The text of the last message so far. */
    get text(): string {
      return message;
    },
  };
}

/** A failure of a turn or of a session setup, as the events say it. */
export interface Failure {
  message: string;
  code: "cli-failed" | "not-logged-in";
  limit?: Limit;
}

const RESET_TIMESTAMP = /quotaResetTimeStamp"?\s*[:=]\s*"?([^\s",\]}]+)/;
const RESET_DELAY = /quotaResetDelay"?\s*[:=]\s*"?([0-9a-zµμ.]+)/;
const RETRY_DELAY = /retryDelay"?\s*[:=]\s*"?([0-9a-zµμ.]+)/;
// Found inside a longer failure text, where the wording is the harness's own.
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
// A whole reply that is nothing but the diagnostic. Prose that quotes it does not match.
const API_ERROR_REPLY = /^\s*Error (\d{3}), Message: ([^\n]+?), Status: ([A-Z_]+)\s*$/;

/** Go durations may carry µs and ns, which `parseDuration` does not read. They are far below what a limit asks for, so they count as 0. */
function goDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const rest = text.replace(/\d+(?:\.\d+)?(?:ns|us|µs|μs)/g, "");
  return rest === "" ? 0 : parseDuration(rest);
}

/**
 * The limit a failure text reports, or undefined when it reports none. `RESOURCE_EXHAUSTED` and `429` are rate limits
 * unless the text says `QUOTA_EXHAUSTED` or asks for a wait over five hours, which is a quota. The reset comes from
 * `quotaResetTimeStamp`, else the delay Google's error carries (`quotaResetDelay`, `retryDelay`).
 */
export function limitFrom(text: string, now = Date.now()): Limit | undefined {
  // `quota` alone is not enough: an auth error can talk about a "quota project". It has to say a quota ran out.
  const quota = /QUOTA_EXHAUSTED|quotaReset|\bquota\b[^.]{0,60}\b(?:exceed|exhaust|reach|limit)|\b(?:exceed|exhaust|reach)\w*\b[^.]{0,60}\bquota\b/i.test(text);
  if (!quota && !/RESOURCE_EXHAUSTED|\b429\b|rate.?limit/i.test(text)) return undefined;
  const stamp = RESET_TIMESTAMP.exec(text)?.[1];
  const parsed = stamp ? Date.parse(stamp) : NaN;
  const delay = goDuration(RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1]);
  const resetAt = !Number.isNaN(parsed) ? new Date(parsed).toISOString() : delay !== undefined && delay > 0 ? new Date(now + delay).toISOString() : undefined;
  const wait = delay ?? (!Number.isNaN(parsed) ? Math.max(0, parsed - now) : undefined);
  const detail = (API_ERROR.exec(text)?.[2] ?? text).trim().slice(0, 500);
  return {
    kind: quota || (wait !== undefined && wait > 5 * 3_600_000) ? "quota" : "rate",
    ...(wait !== undefined ? { retryAfterMs: Math.round(wait) } : {}),
    ...(resetAt ? { resetAt } : {}),
    detail,
  };
}

const AUTH = /not (?:logged|signed) in|sign in|log ?in required|authentication (?:is )?required|auth_required|unauthenticated|UNAUTHENTICATED|\b401\b/i;

/** What a JSON-RPC error from `agy acp` means for the run. */
export function failureFromError(error: { code?: number; message?: string; data?: unknown }): Failure {
  const text = `${error.message ?? ""} ${error.data === undefined ? "" : typeof error.data === "string" ? error.data : JSON.stringify(error.data)}`;
  // Subscription and sign-in first: their texts can mention a quota project, and they must not read as a limit.
  if (/SUBSCRIPTION_REQUIRED/.test(text)) return { message: "This Google account has no Antigravity subscription (SUBSCRIPTION_REQUIRED).", code: "cli-failed" };
  if (AUTH.test(text)) return { message: "Run agy in a terminal and sign in.", code: "not-logged-in" };
  const limit = limitFrom(text);
  if (limit) return { message: limit.detail, code: "cli-failed", limit };
  return { message: (error.message ?? "agy acp failed.").trim() || "agy acp failed.", code: "cli-failed" };
}

/**
 * The failure behind a turn that ended with `end_turn` or `refusal`. agy maps only the quota stop reason to
 * `refusal`. An upstream API failure arrives as a chat message and `end_turn`, in the Go harness's wording
 * `Error 429, Message: ..., Status: RESOURCE_EXHAUSTED`. Only a reply that is that line and nothing else is read as the
 * failure: an answer that quotes the wording in prose, in a code span or after other text is the model's own, and a
 * successful turn stays successful.
 */
export function failureFromTurn(stopReason: string, text: string): Failure | undefined {
  if (stopReason === "refusal") {
    const quota = "You have reached your Antigravity quota for this period.";
    const found = limitFrom(text);
    return { message: quota, code: "cli-failed", limit: { ...found, kind: "quota", detail: found?.detail ?? quota } };
  }
  const api = API_ERROR_REPLY.exec(text);
  if (!api) return undefined;
  const failure = failureFromError({ message: text });
  return failure.limit ? failure : { message: api[2]!.trim(), code: "cli-failed" };
}
