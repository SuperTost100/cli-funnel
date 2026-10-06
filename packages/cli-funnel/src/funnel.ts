import { loadManifest } from "./catalog/manifest.js";
import { validateSelection } from "./selection.js";
import { collect } from "./providers/base.js";
import { PROVIDERS } from "./providers/index.js";
import { createApiProviders, type ApiKeys } from "./providers/api.js";
import { createOllamaProvider, type OllamaOptions } from "./providers/ollama/index.js";
import {
  FunnelError,
  type AuthStatus,
  type FunnelEvent,
  type Installation,
  type LoginSession,
  type ModelInfo,
  type Provider,
  type ProviderId,
  type PullEvent,
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

export function createFunnel(options: FunnelOptions = {}) {
  const registry: Record<ProviderId, Provider> = {
    ...PROVIDERS,
    ...(options.apiKeys ? createApiProviders(options.apiKeys) : {}),
    ...(options.ollama ? { ollama: createOllamaProvider(options.ollama) } : {}),
    ...options.providers,
  } as Record<ProviderId, Provider>;
  const provider = (id: ProviderId): Provider => {
    const p = registry[id];
    if (!p) throw new FunnelError(`Unknown provider "${id}".`, "invalid-selection");
    return p;
  };

  async function prepare(input: RunInput) {
    const p = provider(input.selection.provider);
    const install = await p.detect();
    if (!install.installed) throw new FunnelError(install.detail ?? `${p.displayName} CLI is not installed.`, "not-installed");
    const models = options.allowUnlistedModels ? undefined : await p.models();
    validateSelection(input.selection, p, models);
    if (input.selection.access === "supervised" && !input.onApproval) {
      throw new FunnelError('access "supervised" needs an onApproval callback.', "invalid-selection");
    }
    if (input.attachments?.length && !p.capabilities.images) {
      throw new FunnelError(`${p.displayName} cannot take image attachments.`, "unsupported");
    }
    return p;
  }

  function stream(input: RunInput): RunStream {
    const events = (async function* () {
      const p = await prepare(input);
      yield* p.run(input);
    })();
    // Tee the stream so both `for await` and `.result` work without double-consuming.
    const buffered: FunnelEvent[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let failure: unknown;
    const iterable: AsyncIterable<FunnelEvent> = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const e of events) {
            buffered.push(e);
            yield e;
          }
        } catch (err) {
          failure = err;
          throw err;
        } finally {
          resolveDone();
        }
      },
    };
    const result = (async () => {
      await done;
      if (failure) throw failure;
      return collect(
        (async function* () {
          yield* buffered;
        })(),
        input,
      );
    })();
    result.catch(() => {});
    return Object.assign(iterable, { result });
  }

  return {
    providers: registry,

    /** Installed and logged-in state for every provider, for a provider picker. */
    async overview(): Promise<ProviderOverview[]> {
      return Promise.all(
        Object.values(registry).map(async (p) => {
          const installation = await (async () => p.detect())().catch((): Installation => ({ installed: false, testedRange: { min: "0" } }));
          const auth = installation.installed ? await (async () => p.authStatus())().catch(() => undefined) : undefined;
          return { id: p.id, displayName: p.displayName, capabilities: p.capabilities, installation, auth };
        }),
      );
    },

    models: async (id: ProviderId): Promise<ModelInfo[]> => provider(id).models(),
    authStatus: async (id: ProviderId): Promise<AuthStatus> => provider(id).authStatus(),
    login: (id: ProviderId, opts?: { signal?: AbortSignal }): LoginSession => provider(id).login(opts),
    logout: async (id: ProviderId): Promise<void> => provider(id).logout(),
    update: async (id: ProviderId): Promise<UpdateResult> => provider(id).update(),
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
