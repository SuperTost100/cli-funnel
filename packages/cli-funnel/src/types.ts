export type CliProviderId = "claude" | "codex" | "agent" | "antigravity";
export type ApiProviderId = "anthropic-api" | "openai-api";
export type ProviderId = CliProviderId | ApiProviderId;

/** How much the agent may do on the machine. Providers list the levels they can really enforce. */
export type AccessLevel = "supervised" | "accept-edits" | "auto" | "full";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["supervised", "accept-edits", "auto", "full"];

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
}

/** The whole UI state in one serializable object. Hardcode it or let the UI produce it. */
export interface Selection {
  provider: ProviderId;
  model: string;
  effort?: string;
  contextWindow?: number;
  fast?: boolean;
  /** Absolute project directory the agent works in. */
  cwd: string;
  access: AccessLevel;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  /** Set only when the CLI reports it. Subscription runs often do not. */
  costUsd?: number;
}

export type FinishReason = "stop" | "cancelled" | "error" | "denied";

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
  | { type: "done"; text: string; finishReason: FinishReason }
  | { type: "error"; message: string; code?: string };

/** What `funnel.run()` resolves to. Shaped like an API response. */
export interface RunResult {
  text: string;
  provider: ProviderId;
  model: string;
  sessionId?: string;
  usage?: Usage;
  finishReason: FinishReason;
  /** Tool calls the agent made, in order. */
  toolCalls: { id: string; name: string; input?: unknown; error?: string }[];
  /** Tool calls the CLI refused because nobody could approve them. */
  deniedActions: string[];
}

export interface RunInput {
  selection: Selection;
  prompt: string;
  /** Continue an earlier conversation. Use the `sessionId` from a previous result. */
  sessionId?: string;
  signal?: AbortSignal;
  /** Called for each tool call that needs approval. Required when `selection.access` is "supervised". */
  onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;
  /** Extra environment for the CLI process. */
  env?: Record<string, string>;
}

export interface Installation {
  installed: boolean;
  path?: string;
  version?: string;
  /** False when the installed version is outside the range this release was tested against. */
  testedRange: { min: string; maxExclusive?: string };
  withinTestedRange?: boolean;
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
  /** Show this URL to the user. The CLI usually opens it too. */
  | { type: "open-url"; url: string }
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

export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Executable name looked up on PATH. */
  readonly binary: string;
  readonly capabilities: Capabilities;
  detect(): Promise<Installation>;
  authStatus(): Promise<AuthStatus>;
  login(options?: { signal?: AbortSignal }): LoginSession;
  logout(): Promise<void>;
  update(): Promise<UpdateResult>;
  models(): Promise<ModelInfo[]>;
  run(input: RunInput): AsyncIterable<FunnelEvent>;
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
