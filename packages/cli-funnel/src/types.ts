export type CliProviderId = "claude" | "codex" | "agent" | "antigravity";
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
}

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

/** A JSON Schema for the final answer. Anthropic and Codex need `additionalProperties: false` on every object. */
export interface ResponseSchema {
  /** Short name, used by APIs that label schemas. Default "response". */
  name?: string;
  schema: Record<string, unknown>;
}

/** `length` means the answer hit the output token limit and is cut off. Only API providers and model servers report it. */
export type FinishReason = "stop" | "cancelled" | "error" | "denied" | "length";

export interface ApprovalRequest {
  id: string;
  tool: string;
  /** Tool input as the CLI reported it. */
  input: unknown;
  description?: string;
}

export type ApprovalDecision = "allow" | "deny";

export type FunnelEvent =
  | { type: "session"; sessionId: string; model?: string }
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.start"; id: string; name: string; input?: unknown }
  | { type: "tool.end"; id: string; output?: string; error?: string }
  /** A provider yields this, then awaits `onApproval` for the answer. */
  | { type: "approval.request"; request: ApprovalRequest }
  | { type: "usage"; usage: Usage }
  /** An API provider got a 429 or 5xx before any output and will send the request again after `delayMs`. `attempt` counts retries from 1. */
  | { type: "retry"; attempt: number; status: number; delayMs: number }
  /** The parsed answer when the provider reports structured output itself. */
  | { type: "structured"; data: unknown }
  /** `timeout` is set when the run hit `RunInput.timeoutMs`. `finishReason` is then "cancelled". */
  | { type: "done"; text: string; finishReason: FinishReason; timeout?: true }
  | { type: "error"; message: string; code?: string };

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
  /** Tool calls the agent made, in order. */
  toolCalls: { id: string; name: string; input?: unknown; error?: string }[];
  /** Tool calls the CLI refused because nobody could approve them. */
  deniedActions: string[];
  /** The parsed answer when `responseSchema` was set. Not validated against the schema: do that yourself. */
  structured?: unknown;
  /** Why `structured` is missing when `responseSchema` was set, for example text that is not JSON. */
  structuredError?: string;
  /** True when the run hit `RunInput.timeoutMs`. `finishReason` is then "cancelled". */
  timeout?: true;
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
  prompt: string;
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
  /** Extra environment for the CLI process. */
  env?: Record<string, string>;
  /** Where providers without server-side sessions keep the conversation. Default: the funnel's `history` option. */
  history?: HistoryStore;
}

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
  /** Executable name looked up on PATH. */
  readonly binary: string;
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
      | "aborted",
  ) {
    super(message);
    this.name = "FunnelError";
  }
}
