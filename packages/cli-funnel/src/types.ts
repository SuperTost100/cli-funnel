/** The CLI providers. Each takes `providerOptions` and has a bundled model list in `data/models/<id>.json`. */
export const PROVIDER_OPTION_IDS = ["claude", "codex", "agent", "antigravity"] as const;
export type CliProviderId = (typeof PROVIDER_OPTION_IDS)[number];
export type ApiProviderId = "anthropic-api" | "openai-api" | "gemini-api";
/** Model servers reached over HTTP. They need no binary. `openai-compatible:<id>` is one configured endpoint. */
export type ServerProviderId = "ollama" | `openai-compatible:${string}`;
export type ProviderId = CliProviderId | ApiProviderId | ServerProviderId;

/**
 * How much the agent may do on the machine. Providers list the levels they can really enforce.
 * `none` is text in, text out: no file writes, no commands, no MCP servers, no approvals.
 */
export type AccessLevel = "none" | "supervised" | "accept-edits" | "auto" | "full";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "supervised", "accept-edits", "auto", "full"];

export interface EffortOption {
  /** Value passed to the CLI, for example "high". */
  id: string;
  label: string;
}

/** One selectable model. `id` is always a concrete, versioned model name. Aliases like "latest" never appear here. */
export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  efforts: EffortOption[];
  defaultEffort?: string;
  /** Selectable context sizes in tokens. Empty when the CLI fixes it. */
  contextWindows: number[];
  defaultContextWindow?: number;
  /** True when the model has a faster, higher-usage tier. */
  fast: boolean;
  /** Where this entry came from. */
  source: "manifest" | "cli";
  /** The OpenAI APIs the model works with. Set on `openai-api` and OpenAI-compatible models. */
  apis?: OpenAIApi[];
}

/** OpenAI's two chat APIs: Chat Completions (`chat`) and Responses (`responses`). */
export type OpenAIApi = "chat" | "responses";

export interface Capabilities {
  /** Access levels this provider can enforce headlessly. `supervised` appears only when approvals can be passed through. Empty means the provider has no machine access (API providers). */
  access: AccessLevel[];
  effort: boolean;
  contextWindow: boolean;
  fast: boolean;
  resume: boolean;
  approvals: boolean;
  /** Accepts image attachments. */
  images: boolean;
  /** True when the provider sends `RunInput.messages` as separate turns. Other providers get them rendered into `prompt`. */
  messages?: boolean;
  /** True when the provider takes `RunInput.tools` and tool parts in `messages`. The CLIs run their own tools instead. */
  tools?: boolean;
  /** `native` when the CLI or API takes a system prompt. `prompt` means cli-funnel puts it in front of the prompt. */
  system: "native" | "prompt";
  /** `native` when the CLI or API enforces `responseSchema`. `prompt` means the schema is only asked for in the prompt. */
  schema: "native" | "prompt";
  /** True when the provider passes `RunInput.sampling` to the model. Runs that set `sampling` on other providers are refused. */
  sampling?: boolean;
  /** True when the provider takes `RunInput.cache` or `RunInput.cachedContent`. Runs that set them on other providers are refused. */
  cache?: boolean;
  /** True when `pullModel` and `deleteModel` work. Model servers such as Ollama. */
  manageModels?: boolean;
  /** The kinds of `RunInput.mcpServers` the provider can attach. Absent or empty means none. */
  mcpServers?: McpServer["type"][];
  /** True when the CLI can run on `RunInput.apiKey` instead of the saved login. */
  apiKey?: boolean;
  /** True when the provider emits `plan` events. */
  plan?: boolean;
  /** True when the provider emits `file.change` events. */
  fileChanges?: boolean;
  /** True when the agent can ask the user through `onQuestion`. */
  questions?: boolean;
  /** True when an approval reply can change the tool input with `updatedInput`. */
  approvalInput?: boolean;
  /** True when the CLI can run the agent's commands in a sandbox for `RunInput.sandbox`. */
  sandbox?: boolean;
}

/** Progress of `pullModel`. The stream ends after `done` or `error`. */
export type PullEvent =
  | { type: "progress"; status: string; digest?: string; completed?: number; total?: number }
  | { type: "done" }
  | { type: "error"; message: string };

/** The whole UI state in one serializable object. Hardcode it or let the UI produce it. */
export interface Selection {
  provider: ProviderId;
  model: string;
  effort?: string;
  contextWindow?: number;
  fast?: boolean;
  /**
   * Absolute project directory the agent works in. Required for providers that list access levels (the CLIs).
   * Providers without a machine (Ollama, the API providers, OpenAI-compatible servers) ignore it.
   */
  cwd?: string;
  /** Required for providers that list access levels (the CLIs). Providers without a machine ignore it. */
  access?: AccessLevel;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Input tokens written to the prompt cache. Counted in `inputTokens`. Anthropic only. */
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  /** Set only when the CLI reports it. Subscription runs often do not. */
  costUsd?: number;
}

/** An image sent with the prompt. `data` is base64 without a `data:` prefix. */
export interface ImageAttachment {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

export type Attachment = ImageAttachment;

export interface TextPart {
  type: "text";
  text: string;
}

/** A call the model made to one of the tools in `RunInput.tools`. */
export interface ToolCall {
  id: string;
  name: string;
  /** The parsed arguments. The raw string when the model wrote arguments that are not JSON. */
  input: unknown;
}

/** In an assistant message: a tool call from an earlier turn. */
export interface ToolCallPart extends ToolCall {
  type: "tool_call";
}

/** In a user message: what your code returned for a tool call. */
export interface ToolResultPart {
  type: "tool_result";
  /** The `id` of the tool call it answers. */
  toolCallId: string;
  output: string;
  /** True when the tool failed and `output` is the error. */
  isError?: boolean;
}

/** One piece of a message. Images use the same shape as attachments. Tool parts need `capabilities.tools`. */
export type ContentPart = TextPart | ImageAttachment | ToolCallPart | ToolResultPart;

/** A tool the model may call. Your code runs it; the model only asks. */
export interface ToolDefinition {
  /** Letters, digits, `_` and `-`, up to 64 characters. The vendors reject other names. */
  name: string;
  description?: string;
  /** JSON Schema of the arguments object. Default: an object with no properties. */
  parameters?: Record<string, unknown>;
}

/** `required` makes the model call some tool; `{ name }` makes it call that one. */
export type ToolChoice = "auto" | "none" | "required" | { name: string };

/**
 * One turn of a conversation, for `RunInput.messages`. A string `content` is the same as one text part.
 * System instructions go in `RunInput.system`, not here.
 */
export interface Message {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

/** A JSON Schema for the final answer. Anthropic and Codex need `additionalProperties: false` on every object. */
export interface ResponseSchema {
  /** Short name, used by APIs that label schemas. Default "response". */
  name?: string;
  schema: Record<string, unknown>;
}

/**
 * `length` means the answer hit the output token limit and is cut off. `tool_calls` means the model waits for the
 * results of the calls in `RunResult.pendingToolCalls`. Only API providers and model servers report these two.
 */
export type FinishReason = "stop" | "cancelled" | "error" | "denied" | "length" | "tool_calls";

export interface ApprovalRequest {
  id: string;
  tool: string;
  /** Tool input as the CLI reported it. */
  input: unknown;
  description?: string;
}

/** An approval answer with more detail than "allow" or "deny". */
export interface ApprovalReply {
  decision: "allow" | "deny";
  /**
   * Why, for the agent. A deny with a message tells the agent why it was refused instead of a generic refusal, so it
   * can change course rather than retry. Providers that cannot pass it on drop it.
   */
  message?: string;
  /**
   * Replaces the tool input on an allow, in the same shape as `ApprovalRequest.input`. Needs `capabilities.approvalInput`.
   * A provider without it denies the call rather than run the original input.
   */
  updatedInput?: unknown;
}

export type ApprovalDecision = "allow" | "deny" | ApprovalReply;

/** One choice of a question. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** One question the agent asks the user. */
export interface Question {
  /** The key of this question in `QuestionAnswers`. */
  id: string;
  /** A short title of a few words. */
  header?: string;
  question: string;
  /** The choices. Empty when the answer is free text only. */
  options: QuestionOption[];
  /** More than one option may be chosen. */
  multiSelect?: boolean;
  /** The user may type an answer that is not one of the options. */
  allowOther?: boolean;
  /** The answer is a secret, such as a password. Do not show it or log it. */
  secret?: boolean;
}

/** Questions the agent asks together. A provider yields `question.request`, then awaits `onQuestion`. */
export interface QuestionRequest {
  id: string;
  questions: Question[];
}

/** Answers keyed by question id. Each answer is the labels of the chosen options, or the user's own text. */
export type QuestionAnswers = Record<string, string[]>;

/** One step of the agent's plan. */
export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "done";
}

/** A file the agent added, changed or deleted. */
export interface FileChange {
  /** The id of the tool call that made the change, the same as its `tool.start`. One call can change several files. */
  id: string;
  /** Absolute path. */
  path: string;
  /** A rename is an `update` with `movedTo`. */
  kind: "add" | "update" | "delete";
  /** Where an update moved the file. Absolute path. */
  movedTo?: string;
  /** `declined` means an approval, a permission rule or the access level refused it. */
  status: "done" | "failed" | "declined";
}

/**
 * An MCP server reached over HTTP. It starts no process on the machine, so every access level but `none` accepts it.
 * The agent calls its tools under the run's access level: at `supervised` each call goes to `onApproval` unless
 * `autoApprove` is set.
 */
export interface McpHttpServer {
  type: "http";
  url: string;
  /** Sent with every request, for example `Authorization`. */
  headers?: Record<string, string>;
  /** Seconds a tool call may run before the agent gives up. Raise it for tools that wait for the user. */
  toolTimeoutSec?: number;
  /** Calls to this server's tools run without asking `onApproval`. The server is the caller's, so the agent gets no new access to the machine. */
  autoApprove?: boolean;
}

/** An MCP server the CLI starts as a command. Starting it runs code before any permission check, so only `full` accepts it. */
export interface McpStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Seconds a tool call may run before the agent gives up. */
  toolTimeoutSec?: number;
}

export type McpServer = McpHttpServer | McpStdioServer;

/**
 * A rate limit or quota the provider hit or reported. `rate` clears within hours: requests per minute, or the
 * five-hour window of a subscription. `quota` lasts longer: a weekly window, used-up credits or a billing cap.
 */
export interface Limit {
  kind: "rate" | "quota";
  /** How long the provider asked to wait before the next request. */
  retryAfterMs?: number;
  /** When the limit resets, as an ISO 8601 timestamp. */
  resetAt?: string;
  /** The provider's own words, for showing to the user. */
  detail: string;
}

export type FunnelEvent =
  /** The run waits for a slot under `maxConcurrentRuns`. `ahead` is the number of runs waiting before it. */
  | { type: "queue.position"; ahead: number }
  /** `auth` says how the CLI signed in for this run, when the provider knows: the saved account login or an API key. */
  | { type: "session"; sessionId: string; model?: string; auth?: "account" | "api-key" }
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  /** A CLI agent started one of its own tools, such as a shell command or a file edit. */
  | { type: "tool.start"; id: string; name: string; input?: unknown }
  | { type: "tool.end"; id: string; output?: string; error?: string }
  /** A piece of the JSON arguments of a call to one of `RunInput.tools`, as the model writes it. Not every vendor streams them. */
  | { type: "tool_call.delta"; id: string; name: string; arguments: string }
  /** A finished call to one of `RunInput.tools`. Your code runs the tool and sends the result in the next run. */
  | ({ type: "tool_call" } & ToolCall)
  /** A provider yields this, then awaits `onApproval` for the answer. */
  | { type: "approval.request"; request: ApprovalRequest }
  /** The agent asks the user. A provider yields this, then awaits `onQuestion` for the answers. */
  | { type: "question.request"; request: QuestionRequest }
  /** The agent's whole plan, each time it changes. Needs `capabilities.plan`. */
  | { type: "plan"; steps: PlanStep[]; explanation?: string }
  /** A file the agent added, changed or deleted, once the change is applied or refused. Needs `capabilities.fileChanges`. */
  | ({ type: "file.change" } & FileChange)
  | { type: "usage"; usage: Usage }
  /**
   * Text a subagent wrote, when `providerOptions.claude.forwardSubagentText` is on. `parentId` is the id of the tool
   * call that started the subagent, so it matches the `tool.start` of that call. It is never part of the run's answer
   * text, and it arrives as whole messages, not as deltas.
   */
  | { type: "subagent.text"; parentId: string; text: string; agent?: string }
  /** The provider hit or reported a limit. An `error` event usually follows when the run could not finish. */
  | ({ type: "limit" } & Limit)
  /** An API provider got a 429 or 5xx before any output and will send the request again after `delayMs`. `attempt` counts retries from 1. */
  | { type: "retry"; attempt: number; status: number; delayMs: number }
  /** The parsed answer when the provider reports structured output itself. */
  | { type: "structured"; data: unknown }
  /** `timeout` is set when the run hit `RunInput.timeoutMs`. `finishReason` is then "cancelled". */
  | { type: "done"; text: string; finishReason: FinishReason; timeout?: true }
  | { type: "error"; message: string; code?: string };

/** A saved conversation a provider can list. */
export interface ThreadInfo {
  provider: ProviderId;
  /** Pass it as `RunInput.sessionId` to continue the conversation. */
  sessionId: string;
  /** The user's title when there is one, else the start of the first message. */
  title: string;
  cwd?: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  /** The session this one was forked from. */
  forkedFrom?: string;
}

export interface ListThreadsOptions extends ProcessOptions {
  /** Only conversations that ran in this folder. */
  cwd?: string;
  /** Substring of the title. */
  search?: string;
  /** Page size. The provider picks one when unset. */
  limit?: number;
  /** `nextCursor` of the previous page. */
  cursor?: string;
}

export interface ThreadPage {
  threads: ThreadInfo[];
  /** Pass it as `cursor` for the next page. Absent on the last page. */
  nextCursor?: string;
}

/** How much of one usage window is used. */
export interface UsageWindow {
  usedPercent: number;
  /** Length of the window, for example 300 for five hours. */
  windowMinutes?: number;
  /** When the window resets, as an ISO 8601 timestamp. */
  resetsAt?: string;
}

/** A provider's account usage right now. See `funnel.rateLimits`. */
export interface RateLimits {
  provider: ProviderId;
  /** The account's plan, for example "plus". */
  plan?: string;
  /** The short window, five hours on Codex. */
  primary?: UsageWindow;
  /** The long window, a week on Codex. */
  secondary?: UsageWindow;
  /** Set when a limit is reached. The same value a `limit` event carries. */
  limit?: Limit;
}

/** Environment and abort signal for the calls that start a short-lived CLI process. */
export interface ProcessOptions {
  /** Extra environment for the CLI process, for example `CODEX_HOME`. */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** What `createFunnel({ onEvent })` receives for every event of a run. */
export interface RunEventRecord {
  runId: string;
  provider: ProviderId;
  /** The model that was asked for. The `session` event may name the one that answered. */
  model: string;
  selection: Selection;
  /**
   * The prompt of the run, repeated on every record. It is the user's text, so do not store it
   * unless the user agreed to that. The built-in JSONL log leaves it out by default.
   */
  prompt: string;
  /** Epoch milliseconds when the run started. */
  startedAt: number;
  /** Epoch milliseconds when this event was seen. */
  time: number;
  event: FunnelEvent;
}

/** What `funnel.run()` resolves to. Shaped like an API response. */
export interface RunResult {
  text: string;
  provider: ProviderId;
  model: string;
  sessionId?: string;
  usage?: Usage;
  finishReason: FinishReason;
  /** How many times an API provider sent the request again after a 429 or 5xx. Absent when it did not. */
  retries?: number;
  /** Tool calls the CLI agent made with its own tools, in order. */
  toolCalls: { id: string; name: string; input?: unknown; error?: string }[];
  /** Calls to `RunInput.tools` that the model waits on, in order. Present when there are any. */
  pendingToolCalls?: ToolCall[];
  /** Tool calls the CLI refused because nobody could approve them. */
  deniedActions: string[];
  /** The parsed answer when `responseSchema` was set. Not validated against the schema: do that yourself. */
  structured?: unknown;
  /** Why `structured` is missing when `responseSchema` was set, for example text that is not JSON. */
  structuredError?: string;
  /** True when the run hit `RunInput.timeoutMs`. `finishReason` is then "cancelled". */
  timeout?: true;
  /** The first limit the provider reported during the run. A run that failed on it throws an error that carries it too. */
  limit?: Limit;
  /** The last plan the agent reported. Present when there was one. */
  plan?: PlanStep[];
  /** Files the agent added, changed or deleted, in order, including refused changes. Present when there are any. */
  fileChanges?: FileChange[];
  /** How the CLI signed in, when the provider reported it. */
  auth?: "account" | "api-key";
}

/** Sampling controls. Each provider sends the fields its vendor accepts and ignores the rest. */
export interface Sampling {
  temperature?: number;
  topP?: number;
  /** Strings that end the answer when the model writes them. */
  stop?: string[];
  /** For repeatable output. The Anthropic API has no seed and ignores it. */
  seed?: number;
}

/** Settings only an Ollama server takes. */
export interface OllamaRunOptions {
  /** How long the server keeps the model loaded after this run: a duration such as `"30m"`, seconds as a number, `-1` for good, `0` to unload at once. Overrides the funnel's `ollama.keepAlive`. */
  keepAlive?: string | number;
  /** Extra entries for the request's `options`, for example `{ top_k: 40, repeat_penalty: 1.1 }`. They win over the fields cli-funnel sets from `sampling`, `maxOutputTokens` and `selection.contextWindow`. */
  options?: Record<string, unknown>;
}

export interface RunInput {
  selection: Selection;
  /** The user's message. When the run was asked with `messages`, the funnel fills this with a text rendering of them. */
  prompt: string;
  /**
   * The conversation as typed turns, instead of `prompt` and `attachments`. It must end with a user message. With
   * `sessionId` the session already holds the earlier turns, so only the messages after the last assistant message are
   * sent; without one the whole array is the conversation. See docs/run-options.md.
   */
  messages?: Message[];
  /** Instructions for the whole run. See `capabilities.system` for how each provider applies them. */
  system?: string;
  /** Images sent with the prompt. Providers without `capabilities.images` refuse the run. */
  attachments?: Attachment[];
  /** Ask for a JSON answer that matches this schema. The result carries it in `structured`. */
  responseSchema?: ResponseSchema;
  /** Upper bound on output tokens. API providers only. CLIs set their own limit. */
  maxOutputTokens?: number;
  /** Temperature, top-p, stop sequences and seed. See `capabilities.sampling`. The vendor may reject values its models do not allow, for example a non-default temperature on recent Claude and OpenAI reasoning models. */
  sampling?: Sampling;
  /**
   * Tools the model may call. A call ends the run with `finishReason: "tool_calls"`. Run the tools, then answer in a
   * new run with `tool_result` parts in `messages`. Needs `capabilities.tools`.
   */
  tools?: ToolDefinition[];
  /** Whether and which tool the model must call. Default `auto`. */
  toolChoice?: ToolChoice;
  /** Ollama only. Other providers ignore it. */
  ollama?: OllamaRunOptions;
  /** Anthropic API: mark the system prompt and the newest turn for prompt caching, so the next turn reads them from the cache. */
  cache?: boolean;
  /** Gemini API: the name of cached content to run against, for example `cachedContents/abc123`. */
  cachedContent?: string;
  /** Continue an earlier conversation. Use the `sessionId` from a previous result. */
  sessionId?: string;
  signal?: AbortSignal;
  /** Names the run in `onEvent` records and logs. Default: generated. The HTTP server passes the id it sends to clients. */
  runId?: string;
  /**
   * Stops the run after this many milliseconds and ends it with `finishReason: "cancelled"` and `timeout: true`.
   * Unset or 0 means no deadline.
   */
  timeoutMs?: number;
  /** Called for each tool call that needs approval. Required when `selection.access` is "supervised". */
  onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;
  /**
   * Called when the agent asks the user questions, on providers with `capabilities.questions`. Return the answers, or
   * null to decline: the agent then learns the user did not answer. Without it the agent cannot ask, and providers
   * refuse the question tool as they did before.
   */
  onQuestion?: (request: QuestionRequest) => Promise<QuestionAnswers | null> | QuestionAnswers | null;
  /**
   * MCP servers to attach to the agent, keyed by a name of letters, digits, `_` and `-`. Servers from the user's own
   * CLI config stay as they are. Needs the server's type in `capabilities.mcpServers`. See `McpHttpServer` and
   * `McpStdioServer` for the access levels each needs.
   */
  mcpServers?: Record<string, McpServer>;
  /**
   * Turns on the agent's plan tool where the CLI leaves it off, so the run emits `plan` events: Codex's `update_plan`,
   * and Claude Code's task tools on models that lack them by default (Sonnet 5, Opus 5.5). The agent may then spend a
   * few tool calls keeping its plan. Default off, which keeps each CLI's own behaviour. No effect at `none`, and none on
   * providers whose agent always has a plan tool.
   */
  planTool?: boolean;
  /**
   * Runs the agent's shell commands in the CLI's own sandbox, so a command can write only inside `cwd`, `addDirs` and
   * the temp folders the CLI allows. A run whose sandbox cannot start fails instead of running without it. Needs
   * `capabilities.sandbox`, and some providers support it only at some access levels (see docs/run-options.md). No
   * effect at `none`, where no command runs. Providers without machine access accept it, since they run no commands.
   */
  sandbox?: boolean;
  /**
   * A vendor API key the CLI runs on instead of the saved login: an Anthropic key for Claude Code, an OpenAI key for
   * Codex, a Cursor key for Cursor Agent, a Gemini key for Antigravity. The saved login stays as it was. Needs
   * `capabilities.apiKey`. It never appears in events, records or logs.
   */
  apiKey?: string;
  /** Extra environment for the CLI process. */
  env?: Record<string, string>;
  /** Where providers without server-side sessions keep the conversation. Default: the funnel's `history` option. */
  history?: HistoryStore;
  /**
   * Extra settings for one CLI, keyed by provider id. Only the entry for `selection.provider` is used. An option that
   * would give the agent more than `selection.access` allows fails the run with `invalid-selection`.
   */
  providerOptions?: ProviderOptions;
}

/** A custom Claude Code subagent. */
export interface ClaudeAgent {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
}

/** Claude Code settings. See docs/providers/claude.md for the access levels each one needs. */
export interface ClaudeOptions {
  /** Tools that run without asking. This only widens access, so only `full` accepts it. */
  allowedTools?: string[];
  /** Tools the agent may not use. */
  disallowedTools?: string[];
  /** More directories the agent may work in. Absolute paths. Refused at `none`. */
  addDirs?: string[];
  /** MCP servers, as `{ mcpServers: { ... } }`. Starting a server runs a command, so only `full` accepts it. */
  mcpConfig?: Record<string, unknown>;
  /** Custom subagents keyed by name. Refused at `none`. */
  agents?: Record<string, ClaudeAgent>;
  /** Models to try in order when the selected one is overloaded, comma-separated. */
  fallbackModel?: string;
  /** Stop once the run's list-price estimate passes this many dollars. */
  maxBudgetUsd?: number;
  /** With `sessionId`, continue in a new session and leave the old one as it was. With `sessions.keepAlive` the old session's live process stays up. */
  forkSession?: boolean;
  /** Emit `subagent.text` events with the text subagents write, tagged with the id of the tool call that started them. */
  forwardSubagentText?: boolean;
  /** Beta headers. Only API key logins use them. */
  betas?: string[];
}

/** Codex settings. See docs/providers/codex.md. */
export interface CodexOptions {
  /** Start a thread Codex does not save. Not with `sessionId`. */
  ephemeral?: boolean;
  /** Codex's `web_search` setting. `none` accepts only "disabled". */
  webSearch?: "disabled" | "cached" | "indexed" | "live";
  /** Ask for approval at least as often as the access level does. A policy that asks less is refused. */
  approvalPolicy?: "untrusted" | "on-request" | "never";
}

/** Cursor Agent settings. See docs/providers/agent.md. */
export interface AgentOptions {
  /** More workspace roots. Absolute paths. Refused at `none`. */
  addDirs?: string[];
  /** Turn the CLI's sandbox on or off. "disabled" only at `full`. */
  sandbox?: "enabled" | "disabled";
  /** Plan mode: the agent proposes changes and makes none. */
  mode?: "plan";
}

/** Antigravity settings. See docs/providers/antigravity.md. */
export interface AntigravityOptions {
  /** More workspace directories. Absolute paths. Refused at `none`. */
  addDirs?: string[];
  /** End the turn after this many seconds. */
  printTimeoutSec?: number;
}

export interface ProviderOptions {
  claude?: ClaudeOptions;
  codex?: CodexOptions;
  agent?: AgentOptions;
  antigravity?: AntigravityOptions;
}

/**
 * What `funnel.run()` and `funnel.stream()` take: a `RunInput` with either `prompt` or `messages`. The funnel turns
 * `messages` into a `prompt` for providers that do not take them, so providers always see a `RunInput`.
 */
export type RunRequest = Omit<RunInput, "prompt"> & { prompt?: string };

/**
 * Conversation storage for providers that keep no session on their side: the API providers, Ollama and
 * OpenAI-compatible servers. Messages are in the provider's own wire format. Treat them as opaque.
 */
export interface HistoryStore {
  get(sessionId: string): Promise<unknown[] | undefined> | unknown[] | undefined;
  set(sessionId: string, messages: unknown[]): Promise<void> | void;
}

export interface Installation {
  installed: boolean;
  path?: string;
  version?: string;
  /** False when the installed version is outside the range this release was tested against. */
  testedRange: { min: string; maxExclusive?: string };
  withinTestedRange?: boolean;
  /** Why the provider is not available, when it knows. For example a model server that does not answer. */
  detail?: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  /** Human label such as "claude.ai" or "ChatGPT". */
  method?: string;
  account?: string;
  plan?: string;
  detail?: string;
}

export type LoginEvent =
  /**
   * The sign-in page. `opened` is true when the CLI has already opened it in the browser, so the host should only
   * offer it as a link; otherwise the host opens it.
   */
  | { type: "open-url"; url: string; opened?: boolean }
  /** The CLI waits for a code the user copies from the browser. Answer with `LoginSession.sendCode`. */
  | { type: "code-prompt"; message: string }
  | { type: "log"; text: string }
  /** The provider has no headless login. Run `command` in a terminal. */
  | { type: "needs-terminal"; command: string[] }
  | { type: "done"; status: AuthStatus }
  | { type: "error"; message: string };

export interface LoginSession extends AsyncIterable<LoginEvent> {
  sendCode(code: string): void;
  cancel(): void;
}

export interface UpdateResult {
  from?: string;
  to?: string;
  changed: boolean;
  output: string;
}

/** What the funnel passes to `Provider.models()`. */
export interface ProviderContext {
  /** URL of a models.json that replaces the bundled model list. The CLI providers read their fallback list from it. */
  manifestUrl?: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  detect(): Promise<Installation>;
  authStatus(): Promise<AuthStatus>;
  /**
   * `device` asks for a device-code login where the CLI has one (Codex), for machines without a local browser. It
   * needs device codes enabled in the account's security settings, so the default is the browser login.
   */
  login(options?: { signal?: AbortSignal; device?: boolean }): LoginSession;
  logout(): Promise<void>;
  update(): Promise<UpdateResult>;
  models(ctx?: ProviderContext): Promise<ModelInfo[]>;
  run(input: RunInput): AsyncIterable<FunnelEvent>;
  /** Downloads a model so it can run. Present when `capabilities.manageModels` is true. Aborting the signal ends the stream. */
  pullModel?(name: string, options?: { signal?: AbortSignal }): AsyncIterable<PullEvent>;
  /** Removes a downloaded model. Present when `capabilities.manageModels` is true. */
  deleteModel?(name: string): Promise<void>;
  /**
   * Starts a CLI process that stays alive across turns, for `createFunnel({ sessions: { keepAlive: true } })`. The
   * process is set up from `input`: its selection, system prompt, schema, env, approval handler and `sessionId` to
   * resume. Run the turns with `turn()`, the first one included.
   */
  openSession?(input: RunInput): Promise<LiveSession>;
  /** Lists the conversations the CLI saved. Codex only. */
  listThreads?(options?: ListThreadsOptions): Promise<ThreadPage>;
  /** Copies a saved conversation into a new one and returns its session id. The original stays as it was. Codex only. */
  forkThread?(sessionId: string, options?: ProcessOptions): Promise<string>;
  /** Reads the account's usage windows. Codex only. */
  rateLimits?(options?: ProcessOptions): Promise<RateLimits>;
}

/** A CLI process that keeps one conversation across turns. Made by `Provider.openSession`. */
export interface LiveSession {
  /** Known once the first turn reported it. */
  readonly sessionId: string | undefined;
  /** False once the process exited or was closed. */
  readonly alive: boolean;
  /**
   * Runs one turn on the live process. One turn at a time. The turn ends with `done` or `error`. The process stays
   * up after a clean end; an abort, a consumer that stops before the end, or a process exit stops it.
   */
  turn(input: RunInput): AsyncIterable<FunnelEvent>;
  /** Adds a user message to the running turn. Absent when the CLI cannot. */
  steer?(text: string): Promise<void>;
  /** Stops the process. */
  close(): void;
}

export class FunnelError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not-installed"
      | "not-logged-in"
      | "unsupported"
      | "invalid-selection"
      | "cli-failed"
      | "aborted"
      /** Refused by `maxConcurrentRuns`: the queue is full or the wait passed `queueTimeoutMs`. */
      | "busy",
  ) {
    super(message);
    this.name = "FunnelError";
  }
}
