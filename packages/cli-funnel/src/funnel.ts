import { observeRun } from "./run-log.js";
import { hasToolParts, toRunInput } from "./messages.js";
import { loadManifest } from "./catalog/manifest.js";
import { validateProviderOptions, validateSelection } from "./selection.js";
import { SessionPool, type LiveSessionInfo, type SessionOptions } from "./sessions.js";
import { createRunFolder } from "./providers/base.js";
import { mcpServersFor } from "./providers/options.js";
import { redactSecrets, runSecrets } from "./util/redact.js";
import { PROVIDERS } from "./providers/index.js";
import { memoryHistory } from "./providers/history.js";
import { createApiProviders, type ApiConfig, type ApiKeys } from "./providers/api.js";
import { createOllamaProvider, type OllamaOptions } from "./providers/ollama/index.js";
import { createOpenAICompatibleProviders, type OpenAICompatibleEndpoint } from "./providers/openai-compatible.js";
import { RunQueue, waitForSlot, type RunLimits } from "./queue.js";
import {
  FunnelError,
  type AuthStatus,
  type FunnelEvent,
  type HistoryStore,
  type Installation,
  type ListThreadsOptions,
  type LoginSession,
  type ModelInfo,
  type ProcessOptions,
  type Provider,
  type ProviderId,
  type PullEvent,
  type RateLimits,
  type ThreadPage,
  type RunEventRecord,
  type RunInput,
  type RunRequest,
  type RunResult,
  type UpdateResult,
} from "./types.js";

/** `maxConcurrentRuns`, `maxQueuedRuns` and `queueTimeoutMs` limit the runs `stream()` and `run()` start at once. */
export interface FunnelOptions extends RunLimits {
  /** URL of a models.json to refresh the bundled model list from. Optional. */
  manifestUrl?: string;
  /** Skip checking the selected model against the catalog. Use for models released after your manifest. */
  allowUnlistedModels?: boolean;
  /** Replace or add providers. Used by tests and by custom providers. */
  providers?: Partial<Record<ProviderId, Provider>>;
  /** API keys for the API providers. Falls back to ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY. `api` can set them too. */
  apiKeys?: ApiKeys;
  /** Per-vendor settings for the API providers: key, base URL, extra headers and retries. A key here wins over `apiKeys`. */
  api?: ApiConfig;
  /** Ollama server settings. Without them the provider uses OLLAMA_HOST or 127.0.0.1:11434, and reports itself not installed when no server answers. */
  ollama?: OllamaOptions;
  /** OpenAI-compatible servers. Each becomes a provider with id `openai-compatible:<id>`. */
  openaiCompatible?: OpenAICompatibleEndpoint[];
  /**
   * Where the API providers, Ollama and OpenAI-compatible servers keep conversations. Default: in this process, up to
   * 500 sessions. Pass `fileHistory(dir)` to keep them across restarts.
   */
  history?: HistoryStore;
  /**
   * Called with every event of every run, with the run id, provider, model and a timestamp. Use it for metrics and audit.
   * It is not awaited, and an error or rejection inside it is ignored, so it cannot slow down or break a run. Keep it
   * quick: a synchronous handler still runs on the event loop. The record repeats the prompt, so do not store that
   * without the user's consent. See `jsonlRunLog` for a ready-made handler.
   */
  onEvent?: (record: RunEventRecord) => unknown;
  /** Keep CLI processes alive between turns. Off by default. See docs/sessions.md. */
  sessions?: SessionOptions;
}

export interface ProviderOverview {
  id: ProviderId;
  displayName: string;
  capabilities: Provider["capabilities"];
  installation: Installation;
  auth?: AuthStatus;
}

export interface RunStream extends AsyncIterable<FunnelEvent> {
  /** Resolves to the API-shaped result once the stream is consumed. */
  result: Promise<RunResult>;
}

/** How long a provider's installation and model list are reused. `refresh()` drops them sooner. */
const CACHE_TTL_MS = 60_000;

/**
 * Runs the provider until `ms` pass. Then it aborts the provider and ends the run itself, so a provider that hangs
 * after the abort cannot keep the run open.
 */
async function* withDeadline(run: (input: RunInput) => AsyncIterable<FunnelEvent>, input: RunInput, ms: number): AsyncGenerator<FunnelEvent> {
  const deadline = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  const it = run({ ...input, signal })[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      resolve("expired");
    }, ms);
  });
  try {
    for (;;) {
      const pending = it.next();
      const next = await Promise.race([pending, expired]);
      if (next === "expired") {
        // The provider may still answer or fail after the abort. Nobody reads it any more.
        pending.catch(() => undefined);
        yield { type: "done", text: "", finishReason: "cancelled", timeout: true };
        return;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    clearTimeout(timer);
    // Closes the provider's generator when the deadline passed or the consumer stopped early.
    void it.return?.()?.catch(() => undefined);
  }
}

export function createFunnel(options: FunnelOptions = {}) {
  const registry: Record<ProviderId, Provider> = {
    ...PROVIDERS,
    ...(options.apiKeys || options.api ? createApiProviders(options.apiKeys, options.api) : {}),
    ...(options.ollama ? { ollama: createOllamaProvider(options.ollama) } : {}),
    ...createOpenAICompatibleProviders(options.openaiCompatible),
    ...options.providers,
  } as Record<ProviderId, Provider>;
  // One store per funnel, so two funnels in a process never read each other's sessions.
  const history = options.history ?? memoryHistory();
  const pool = options.sessions?.keepAlive ? new SessionPool(options.sessions) : undefined;
  const queue = RunQueue.from(options);
  const provider = (id: ProviderId): Provider => {
    const p = registry[id];
    if (!p) throw new FunnelError(`Unknown provider "${id}".`, "invalid-selection");
    return p;
  };

  // One entry per provider. A pending entry has `expires: Infinity`, so concurrent callers share its promise.
  type Entry<T> = { value: Promise<T>; expires: number };
  const installations = new Map<ProviderId, Entry<Installation>>();
  const modelLists = new Map<ProviderId, Entry<ModelInfo[]>>();
  function cached<T>(map: Map<ProviderId, Entry<T>>, id: ProviderId, load: () => Promise<T>, keep: (v: T) => boolean = () => true): Promise<T> {
    const hit = map.get(id);
    if (hit && hit.expires > Date.now()) return hit.value;
    const entry: Entry<T> = { value: Promise.resolve().then(load), expires: Infinity };
    map.set(id, entry);
    entry.value.then(
      (v) => {
        if (keep(v)) entry.expires = Date.now() + CACHE_TTL_MS;
        else if (map.get(id) === entry) map.delete(id);
      },
      () => {
        if (map.get(id) === entry) map.delete(id);
      },
    );
    return entry.value;
  }
  // A CLI that is not installed is not cached, so installing it takes effect on the next call.
  const detect = (p: Provider) => cached(installations, p.id, () => p.detect(), (i) => i.installed);
  const modelsOf = (p: Provider) => cached(modelLists, p.id, () => p.models({ manifestUrl: options.manifestUrl }));

  function refresh(id?: ProviderId): void {
    if (id) provider(id);
    for (const map of [installations, modelLists]) {
      if (id) map.delete(id);
      else map.clear();
    }
  }

  async function prepare(input: RunInput) {
    const p = provider(input.selection.provider);
    const install = await detect(p);
    if (!install.installed) throw new FunnelError(install.detail ?? `${p.displayName} CLI is not installed.`, "not-installed");
    const models = options.allowUnlistedModels ? undefined : await modelsOf(p);
    validateSelection(input.selection, p, models);
    validateProviderOptions(input.providerOptions);
    if (p.capabilities.access.length > 0 && input.selection.access === "supervised" && !input.onApproval) {
      throw new FunnelError('access "supervised" needs an onApproval callback.', "invalid-selection");
    }
    if (input.sampling && !p.capabilities.sampling) {
      throw new FunnelError(`${p.displayName} does not take sampling options.`, "unsupported");
    }
    if ((input.cache || input.cachedContent) && !p.capabilities.cache) {
      throw new FunnelError(`${p.displayName} does not take prompt cache options.`, "unsupported");
    }
    if ((input.tools?.length || input.toolChoice || (input.messages && hasToolParts(input.messages))) && !p.capabilities.tools) {
      throw new FunnelError(`${p.displayName} does not take caller-defined tools. It runs its own.`, "unsupported");
    }
    if (input.attachments?.length && !p.capabilities.images) {
      throw new FunnelError(`${p.displayName} cannot take image attachments.`, "unsupported");
    }
    mcpServersFor(input, p.capabilities.mcpServers ?? [], p.displayName);
    // Providers read it by truthiness, so a JSON body with "false" as a string would turn the tool on.
    if (input.planTool !== undefined && typeof input.planTool !== "boolean") throw new FunnelError("planTool must be true or false.", "invalid-selection");
    if (input.apiKey !== undefined) {
      if (!p.capabilities.apiKey) throw new FunnelError(`${p.displayName} cannot run on an API key passed with the run.`, "unsupported");
      if (typeof input.apiKey !== "string" || !input.apiKey.trim()) throw new FunnelError("apiKey must be a non-empty string.", "invalid-selection");
    }
    return p;
  }

  function stream(request: RunRequest): RunStream {
    // A bad request fails like a bad selection: as the first thing the stream does, not as a throw from stream().
    let input: RunInput;
    let invalid: unknown;
    try {
      input = toRunInput(request);
    } catch (err) {
      invalid = err;
      input = { ...request, prompt: request.prompt ?? "" };
    }
    const source = (async function* (): AsyncGenerator<FunnelEvent> {
      if (invalid) throw invalid;
      const p = await prepare(input);
      const runInput = input.history ? input : { ...input, history };
      const run = (i: RunInput) => (pool ? pool.run(p, i) : p.run(i));
      const release = queue ? yield* waitForSlot(queue, p.id, input.signal) : () => undefined;
      if (!release) return yield { type: "done", text: "", finishReason: "cancelled" };
      try {
        yield* input.timeoutMs ? withDeadline(run, runInput, input.timeoutMs) : run(runInput);
      } finally {
        release();
      }
    })();
    const masked = redactSecrets(source, runSecrets(input));
    const events = options.onEvent ? observeRun(options.onEvent, input, masked) : masked;
    // Fold events as they pass, so `.result` works next to `for await` without keeping them.
    const folder = createRunFolder(input);
    let settle!: { resolve: (r: RunResult) => void; reject: (e: unknown) => void };
    const result = new Promise<RunResult>((resolve, reject) => (settle = { resolve, reject }));
    result.catch(() => {});
    const iterable: AsyncIterable<FunnelEvent> = {
      async *[Symbol.asyncIterator]() {
        let failed = false;
        let failure: unknown;
        let ended = false;
        let terminal = false;
        try {
          for await (const e of events) {
            if (!failed) {
              try {
                folder.add(e);
              } catch (err) {
                failed = true;
                failure = err;
              }
            }
            if (e.type === "done" || e.type === "error") terminal = true;
            yield e;
          }
          ended = true;
        } catch (err) {
          if (!failed) {
            failed = true;
            failure = err;
          }
          throw err;
        } finally {
          // A consumer that stops before a terminal event closes `events`, which stops the provider. The answer is partial.
          if (failed) settle.reject(failure);
          else settle.resolve(folder.finish(ended || terminal ? undefined : "cancelled"));
        }
      },
    };
    return Object.assign(iterable, { result });
  }

  return {
    providers: registry,

    /** Installed and logged-in state for every provider, for a provider picker. */
    async overview(): Promise<ProviderOverview[]> {
      return Promise.all(
        Object.values(registry).map(async (p) => {
          const installation = await detect(p).catch((): Installation => ({ installed: false, testedRange: { min: "0" } }));
          const auth = installation.installed ? await (async () => p.authStatus())().catch(() => undefined) : undefined;
          return { id: p.id, displayName: p.displayName, capabilities: p.capabilities, installation, auth };
        }),
      );
    },

    models: async (id: ProviderId): Promise<ModelInfo[]> => modelsOf(provider(id)),
    /** Drops the cached installation and model list of one provider, or of all. The next call looks again. */
    refresh,
    authStatus: async (id: ProviderId): Promise<AuthStatus> => provider(id).authStatus(),
    login: (id: ProviderId, opts?: { signal?: AbortSignal; device?: boolean }): LoginSession => provider(id).login(opts),
    async logout(id: ProviderId): Promise<void> {
      const p = provider(id);
      await p.logout();
      // A CLI can exit 0 and still keep the account, so ask it again before reporting success.
      if ((await p.authStatus()).loggedIn) throw new FunnelError(`${p.displayName} still reports a signed-in account after logout.`, "cli-failed");
    },
    async update(id: ProviderId): Promise<UpdateResult> {
      try {
        return await provider(id).update();
      } finally {
        // The version and the model list may have changed.
        refresh(id);
      }
    },
    /** Downloads a model on providers with `capabilities.manageModels`. Throws `unsupported` elsewhere. */
    pullModel(id: ProviderId, name: string, opts?: { signal?: AbortSignal }): AsyncIterable<PullEvent> {
      const p = provider(id);
      if (!p.pullModel) throw new FunnelError(`${p.displayName} cannot pull models.`, "unsupported");
      return p.pullModel(name, opts);
    },
    /** Removes a downloaded model on providers with `capabilities.manageModels`. Throws `unsupported` elsewhere. */
    async deleteModel(id: ProviderId, name: string): Promise<void> {
      const p = provider(id);
      if (!p.deleteModel) throw new FunnelError(`${p.displayName} cannot delete models.`, "unsupported");
      await p.deleteModel(name);
    },
    manifest: () => loadManifest(options.manifestUrl),

    stream,

    /**
     * Adds a user message to the turn running in a live session. Needs `sessions.keepAlive`. Codex only: other
     * providers throw `unsupported`. Pass `provider` when two providers could share a session id.
     */
    async steer(sessionId: string, text: string, provider?: ProviderId): Promise<void> {
      if (!pool) throw new FunnelError("steer needs createFunnel({ sessions: { keepAlive: true } }).", "unsupported");
      await pool.steer(sessionId, text, provider);
    },
    /** Live sessions kept by `sessions.keepAlive`. Empty without it. */
    sessions: (): LiveSessionInfo[] => pool?.list() ?? [],
    /** Stops the live process of one session. The next turn resumes it in a new process. False when it had none. */
    closeSession: (sessionId: string, provider?: ProviderId): boolean => pool?.close(sessionId, provider) ?? false,
    /** Stops every live session process. Running turns end as cancelled. */
    close(): void {
      pool?.closeAll();
    },
    /** True when the funnel was made with `sessions.keepAlive`. */
    sessionsEnabled: Boolean(pool),

    /** Lists the conversations a CLI saved, newest first. Codex only: other providers throw `unsupported`. */
    async listThreads(id: ProviderId, opts?: ListThreadsOptions): Promise<ThreadPage> {
      const p = provider(id);
      if (!p.listThreads) throw new FunnelError(`${p.displayName} cannot list saved conversations.`, "unsupported");
      return p.listThreads(opts);
    },
    /**
     * Copies a saved conversation into a new one and resolves with the new session id. The original stays as it was.
     * Codex only: other providers throw `unsupported`. Claude Code forks on a run, with `providerOptions.claude.forkSession`.
     */
    async forkSession(id: ProviderId, sessionId: string, opts?: ProcessOptions): Promise<string> {
      const p = provider(id);
      if (!p.forkThread) {
        const hint = id === "claude" ? " Set providerOptions.claude.forkSession on a run with a sessionId instead." : "";
        throw new FunnelError(`${p.displayName} cannot fork a conversation without running it.${hint}`, "unsupported");
      }
      return p.forkThread(sessionId, opts);
    },
    /** The account's usage windows now, and the limit that is reached, if any. Codex only: other providers throw `unsupported`. */
    async rateLimits(id: ProviderId, opts?: ProcessOptions): Promise<RateLimits> {
      const p = provider(id);
      if (!p.rateLimits) throw new FunnelError(`${p.displayName} cannot report its usage windows.`, "unsupported");
      return p.rateLimits(opts);
    },

    /** Runs one turn and resolves with the final text, usage and tool calls. */
    async run(input: RunRequest): Promise<RunResult> {
      const s = stream(input);
      for await (const _ of s) {
        /* drain */
      }
      return s.result;
    },
  };
}

export type Funnel = ReturnType<typeof createFunnel>;
