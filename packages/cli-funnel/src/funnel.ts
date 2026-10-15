import { observeRun } from "./run-log.js";
import { loadManifest } from "./catalog/manifest.js";
import { validateSelection } from "./selection.js";
import { createRunFolder } from "./providers/base.js";
import { PROVIDERS } from "./providers/index.js";
import { memoryHistory } from "./providers/history.js";
import { createApiProviders, type ApiKeys } from "./providers/api.js";
import { createOllamaProvider, type OllamaOptions } from "./providers/ollama/index.js";
import { createOpenAICompatibleProviders, type OpenAICompatibleEndpoint } from "./providers/openai-compatible.js";
import {
  FunnelError,
  type AuthStatus,
  type FunnelEvent,
  type HistoryStore,
  type Installation,
  type LoginSession,
  type ModelInfo,
  type Provider,
  type ProviderId,
  type PullEvent,
  type RunEventRecord,
  type RunInput,
  type RunResult,
  type UpdateResult,
} from "./types.js";

export interface FunnelOptions {
  /** URL of a models.json to refresh the bundled model list from. Optional. */
  manifestUrl?: string;
  /** Skip checking the selected model against the catalog. Use for models released after your manifest. */
  allowUnlistedModels?: boolean;
  /** Replace or add providers. Used by tests and by custom providers. */
  providers?: Partial<Record<ProviderId, Provider>>;
  /** API keys for the API providers. Falls back to ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY. */
  apiKeys?: ApiKeys;
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

export function createFunnel(options: FunnelOptions = {}) {
  const registry: Record<ProviderId, Provider> = {
    ...PROVIDERS,
    ...(options.apiKeys ? createApiProviders(options.apiKeys) : {}),
    ...(options.ollama ? { ollama: createOllamaProvider(options.ollama) } : {}),
    ...createOpenAICompatibleProviders(options.openaiCompatible),
    ...options.providers,
  } as Record<ProviderId, Provider>;
  // One store per funnel, so two funnels in a process never read each other's sessions.
  const history = options.history ?? memoryHistory();
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
    if (p.capabilities.access.length > 0 && input.selection.access === "supervised" && !input.onApproval) {
      throw new FunnelError('access "supervised" needs an onApproval callback.', "invalid-selection");
    }
    if (input.sampling && !p.capabilities.sampling) {
      throw new FunnelError(`${p.displayName} does not take sampling options.`, "unsupported");
    }
    if (input.attachments?.length && !p.capabilities.images) {
      throw new FunnelError(`${p.displayName} cannot take image attachments.`, "unsupported");
    }
    return p;
  }

  function stream(input: RunInput): RunStream {
    const source = (async function* () {
      const p = await prepare(input);
      yield* p.run(input.history ? input : { ...input, history });
    })();
    const events = options.onEvent ? observeRun(options.onEvent, input, source) : source;
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
    logout: async (id: ProviderId): Promise<void> => provider(id).logout(),
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

    /** Runs one turn and resolves with the final text, usage and tool calls. */
    async run(input: RunInput): Promise<RunResult> {
      const s = stream(input);
      for await (const _ of s) {
        /* drain */
      }
      return s.result;
    },
  };
}

export type Funnel = ReturnType<typeof createFunnel>;
