import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AuthStatus,
  FinishReason,
  FunnelClient,
  FunnelEvent,
  LoginEvent,
  ModelInfo,
  ProviderOverview,
  RunInput,
  Selection,
  Usage,
} from "cli-funnel/client";

export type SelectionField = keyof Selection;

/** Extra fields for one `useRun().send` call. */
export type RunOptions = Pick<RunInput, "system" | "attachments" | "responseSchema" | "maxOutputTokens">;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Loads installed providers and their login state. */
export function useProviders(client: FunnelClient) {
  const [providers, setProviders] = useState<ProviderOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const latest = useRef<AbortController | undefined>(undefined);
  // A newer refresh aborts the older one, so a slow old response cannot land last.
  const refresh = useCallback(async () => {
    latest.current?.abort();
    const ctl = new AbortController();
    latest.current = ctl;
    try {
      const list = await client.providers(ctl.signal);
      if (ctl.signal.aborted) return;
      setProviders(list);
      setError(undefined);
    } catch (e) {
      if (!ctl.signal.aborted) setError(messageOf(e));
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    return () => latest.current?.abort();
  }, [refresh]);
  return { providers, loading, error, refresh };
}

/**
 * Holds a Selection and keeps it valid. Change the provider and the model, effort, context,
 * fast and access fall back to values that provider supports. `locked` fields never change,
 * and `problem` says so when the provider cannot honor one of them.
 */
export function useSelection(
  client: FunnelClient,
  opts: {
    defaults?: Partial<Selection>;
    locked?: Partial<Selection>;
    /** Chooses the model and effort to start from when the provider changes, for example the cheapest one. */
    pick?: (provider: Selection["provider"], models: ModelInfo[]) => { model?: string; effort?: string } | undefined;
  } = {},
) {
  const { providers, loading: loadingProviders, error, refresh: refreshProviders } = useProviders(client);
  const [loaded, setLoaded] = useState<{ provider: string; models: ModelInfo[]; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState<Partial<Selection>>({ ...opts.defaults, ...opts.locked });
  const locked = opts.locked ?? {};
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const providerId = locked.provider ?? draft.provider ?? providers.find((p) => p.installation.installed && p.auth?.loggedIn)?.id ?? providers.find((p) => p.installation.installed)?.id;
  const overview = providers.find((p) => p.id === providerId);

  // Only trust a model list that belongs to the current provider. Right after a switch the old list is still in state.
  const current = loaded && loaded.provider === providerId ? loaded : undefined;
  const models = useMemo(() => current?.models ?? [], [current]);

  useEffect(() => {
    if (!providerId) return;
    const ctl = new AbortController();
    client.models(providerId, ctl.signal).then(
      (m) => ctl.signal.aborted || setLoaded({ provider: providerId, models: m }),
      (e) => ctl.signal.aborted || setLoaded({ provider: providerId, models: [], error: messageOf(e) }),
    );
    return () => ctl.abort();
  }, [client, providerId, retry]);

  const picked = useMemo(() => (providerId ? opts.pick?.(providerId, models) : undefined), [providerId, models, opts.pick]);
  // A locked model that the provider does not list stays unresolved, so `problem` can report it.
  const lockedModel = locked.model;
  const model = useMemo(
    () => models.find((m) => m.id === (lockedModel ?? draft.model)) ?? (lockedModel ? undefined : (models.find((m) => m.id === picked?.model) ?? models[0])),
    [models, lockedModel, draft.model, picked],
  );

  const selection = useMemo<Partial<Selection>>(() => {
    if (!providerId || !overview) return { ...draft, ...locked };
    const cap = overview.capabilities;
    const pickedEffort = model?.id === picked?.model && model?.efforts.some((e) => e.id === picked?.effort) ? picked?.effort : undefined;
    const effort = model?.efforts.some((e) => e.id === draft.effort) ? draft.effort : pickedEffort ?? model?.defaultEffort ?? model?.efforts[0]?.id;
    const contextWindow = model?.contextWindows.includes(draft.contextWindow ?? -1) ? draft.contextWindow : model?.defaultContextWindow ?? model?.contextWindows[0];
    // `none` is never the default: coding UIs expect an agent that can act. Pick it explicitly or lock it.
    const access = cap.access.includes(draft.access as never) ? draft.access : (cap.access.find((a) => a !== "none") ?? cap.access[0]);
    return {
      provider: providerId,
      model: model?.id,
      effort: cap.effort ? effort : undefined,
      contextWindow: cap.contextWindow ? contextWindow : undefined,
      fast: cap.fast && model?.fast ? !!draft.fast : undefined,
      cwd: draft.cwd,
      access,
      ...locked,
    };
  }, [draft, model, overview, providerId, locked, picked]);

  // Locked fields skip the fallbacks above, so check them against what the provider can do.
  const modelsReady = !!current;
  const problem = useMemo(() => {
    if (!overview || !modelsReady) return undefined;
    const cap = overview.capabilities;
    const name = overview.displayName;
    const forModel = model ? ` for ${model.name}` : "";
    if (locked.model && models.length > 0 && !model) return `${name} has no model ${locked.model}.`;
    if (locked.access && cap.access.length > 0 && !cap.access.includes(locked.access)) return `${name} does not offer ${locked.access} access.`;
    if (locked.effort !== undefined && (!cap.effort || (model && !model.efforts.some((e) => e.id === locked.effort)))) return `${name} does not offer reasoning effort ${locked.effort}${forModel}.`;
    if (locked.contextWindow !== undefined && (!cap.contextWindow || (model && !model.contextWindows.includes(locked.contextWindow)))) return `${name} does not offer a ${locked.contextWindow} token context window${forModel}.`;
    if (locked.fast && (!cap.fast || (model && !model.fast))) return `${name} does not offer fast mode${forModel}.`;
    return undefined;
  }, [overview, modelsReady, models, model, locked.model, locked.access, locked.effort, locked.contextWindow, locked.fast]);

  const set = useCallback(
    (patch: Partial<Selection>) =>
      setDraft((d) => {
        // Locked fields ignore changes. Without this a locked provider could still reset the model.
        const allowed = Object.fromEntries(Object.entries(patch).filter(([k]) => !(k in lockedRef.current))) as Partial<Selection>;
        // A new provider brings its own models, so nothing tied to the old model carries over.
        const switching = allowed.provider !== undefined && allowed.provider !== d.provider;
        return { ...d, ...(switching ? { model: undefined, effort: undefined, contextWindow: undefined, fast: undefined } : {}), ...allowed };
      }),
    [],
  );

  // Providers without access levels (Ollama, API keys) have no machine, so they need no folder and no access level.
  const machine = (overview?.capabilities.access.length ?? 0) > 0;
  const complete = !!(overview && modelsReady && !problem && selection.provider && selection.model && (!machine || (selection.cwd && selection.access)));
  const refresh = useCallback(async () => {
    setRetry((n) => n + 1);
    await refreshProviders();
  }, [refreshProviders]);

  return {
    providers,
    models,
    overview,
    model,
    selection,
    /**
     * A full Selection once provider and model are set, plus folder and access level for providers that have them.
     * Providers without access levels get `access: "none"` and an empty `cwd`, which they ignore.
     */
    value: complete ? ({ ...selection, cwd: selection.cwd ?? "", access: selection.access ?? "none" } as Selection) : undefined,
    set,
    loading: loadingProviders,
    error,
    /** Why the model list could not load. `refresh()` tries again. */
    modelsError: current?.error,
    /** Set when a locked field does not fit the provider. `value` stays undefined until it does. */
    problem,
    refresh,
  };
}

/** Sign-in, sign-out and one-click update for one provider. */
export function useAuth(client: FunnelClient, provider: Selection["provider"], onChange?: () => void) {
  const [state, setState] = useState<{ provider: string; status: AuthStatus }>();
  // The status belongs to one provider. Show nothing until the new provider's status lands.
  const status = state?.provider === provider ? state.status : undefined;
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [busy, setBusy] = useState<"login" | "update" | "logout">();
  const [message, setMessage] = useState<string>();
  const loginId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const latest = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    latest.current?.abort();
    const ctl = new AbortController();
    latest.current = ctl;
    const next = await client.authStatus(provider, ctl.signal).catch((): AuthStatus => ({ loggedIn: false }));
    if (!ctl.signal.aborted) setState({ provider, status: next });
  }, [client, provider]);

  const cancel = useCallback(() => {
    // The login may already be over by the time the cancel arrives, so a failed cancel is fine.
    if (loginId.current) client.cancelLogin(loginId.current).catch(() => {});
    abort.current?.abort();
  }, [client]);

  useEffect(() => {
    void refresh();
    return () => {
      // Provider change or unmount: stop the login on the server and drop whatever was in flight.
      latest.current?.abort();
      cancel();
      abort.current = undefined;
      loginId.current = undefined;
      setBusy(undefined);
      setEvents([]);
      setMessage(undefined);
    };
  }, [refresh, cancel]);

  const login = useCallback(async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy("login");
    setEvents([]);
    try {
      for await (const e of client.login(provider, ctl.signal)) {
        if (abort.current !== ctl) return;
        if (e.type === "login") loginId.current = e.loginId;
        else setEvents((prev) => [...prev, e]);
      }
    } catch (e) {
      if (abort.current === ctl) setEvents((prev) => [...prev, { type: "error", message: messageOf(e) }]);
    }
    // Unmounted or switched provider while waiting: the cleanup already reset everything.
    if (abort.current !== ctl) return;
    abort.current = undefined;
    loginId.current = undefined;
    setBusy(undefined);
    await refresh();
    onChange?.();
  }, [client, provider, refresh, onChange]);

  const sendCode = useCallback((code: string) => loginId.current && client.sendLoginCode(loginId.current, code), [client]);

  const logout = useCallback(async () => {
    setBusy("logout");
    try {
      await client.logout(provider);
    } catch (e) {
      setMessage(messageOf(e));
    }
    setBusy(undefined);
    await refresh();
    onChange?.();
  }, [client, provider, refresh, onChange]);

  const update = useCallback(async () => {
    setBusy("update");
    try {
      const r = await client.update(provider);
      setMessage(r.changed ? `Updated ${r.from} to ${r.to}` : `Already up to date${r.to ? ` (${r.to})` : ""}`);
    } catch (e) {
      setMessage(messageOf(e));
    }
    setBusy(undefined);
    onChange?.();
  }, [client, provider, onChange]);

  return { status, events, busy, message, login, sendCode, cancel, logout, update, refresh };
}

/** Runs prompts and exposes streaming text, tool calls and pending approvals. */
export function useRun(client: FunnelClient) {
  const [text, setText] = useState("");
  const [events, setEvents] = useState<FunnelEvent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<{ id: string; provider: string; cwd: string }>();
  // What the run was started with. Later changes to the picker must not relabel its answer.
  const [started, setStarted] = useState<{ provider: Selection["provider"]; model: string }>();
  const runId = useRef<string | undefined>(undefined);
  // The controller of the run that owns the state. A run that is no longer this one is stale and writes nothing.
  const abort = useRef<AbortController | undefined>(undefined);

  const send = useCallback(
    async (prompt: string, selection: Selection, options: RunOptions = {}) => {
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      const chosen = { ...selection };
      runId.current = undefined;
      setText("");
      setEvents([]);
      setApprovals([]);
      setError(undefined);
      setStarted({ provider: chosen.provider, model: chosen.model });
      setStatus("running");
      try {
        // A session belongs to one provider and folder. Resuming it anywhere else fails inside the CLI.
        const resume = session && session.provider === chosen.provider && session.cwd === chosen.cwd ? session.id : undefined;
        for await (const e of client.run({ ...options, prompt, selection: chosen, sessionId: resume }, ctl.signal)) {
          if (abort.current !== ctl) return;
          if (ctl.signal.aborted) break;
          if (e.type === "run") {
            runId.current = e.runId;
            continue;
          }
          setEvents((prev) => [...prev, e]);
          if (e.type === "text.delta") setText((t) => t + e.text);
          else if (e.type === "done" && e.text) setText(e.text);
          else if (e.type === "session") setSession({ id: e.sessionId, provider: chosen.provider, cwd: chosen.cwd });
          else if (e.type === "approval.request") setApprovals((a) => [...a, e.request]);
          else if (e.type === "error") {
            setError(e.message);
            setStatus("error");
          }
        }
        if (abort.current !== ctl) return;
        setStatus((s) => (s === "error" ? s : "done"));
      } catch (e) {
        if (abort.current !== ctl) return;
        if (ctl.signal.aborted) setStatus("done");
        else {
          setError(messageOf(e));
          setStatus("error");
        }
      }
    },
    [client, session],
  );

  const approve = useCallback(
    async (id: string, decision: ApprovalDecision) => {
      const ctl = abort.current;
      if (!runId.current) return;
      try {
        await client.approve(runId.current, id, decision);
      } catch (e) {
        // Keep the prompt on screen so the user can try again.
        if (abort.current === ctl) setError(messageOf(e));
        return;
      }
      if (abort.current !== ctl) return;
      setApprovals((a) => a.filter((r) => r.id !== id));
      setError(undefined);
    },
    [client],
  );

  const result = useMemo(() => {
    const out = {
      text: "",
      provider: started?.provider,
      model: started?.model,
      sessionId: undefined as string | undefined,
      usage: undefined as Usage | undefined,
      finishReason: undefined as FinishReason | undefined,
      toolCalls: [] as { id: string; name: string; input?: unknown; error?: string }[],
      /** Tool calls the CLI refused because nobody could approve them. */
      deniedActions: [] as string[],
      /** The parsed answer when the provider reports structured output itself. */
      structured: undefined as unknown,
    };
    for (const e of events) {
      if (e.type === "session") {
        out.sessionId = e.sessionId;
        out.model = e.model ?? out.model;
      } else if (e.type === "text.delta") out.text += e.text;
      else if (e.type === "tool.start") out.toolCalls.push({ id: e.id, name: e.name, input: e.input });
      else if (e.type === "tool.end") {
        const call = out.toolCalls.find((c) => c.id === e.id);
        if (call && e.error) call.error = e.error;
        if (e.error?.startsWith("denied:")) out.deniedActions.push(call?.name ?? e.error.slice(7).trim());
      } else if (e.type === "usage") out.usage = e.usage;
      else if (e.type === "structured") out.structured = e.data;
      else if (e.type === "done") {
        if (e.text) out.text = e.text;
        out.finishReason = e.finishReason;
      }
    }
    return out;
  }, [events, started]);

  const cancel = useCallback(() => abort.current?.abort(), []);
  // Starting over ends the run in flight, so its late events cannot bring the old session back.
  const reset = useCallback(() => {
    abort.current?.abort();
    abort.current = undefined;
    setApprovals([]);
    setStatus((s) => (s === "running" ? "done" : s));
    setSession(undefined);
  }, []);

  // Leaving the page ends the run instead of letting it stream into nothing.
  useEffect(
    () => () => {
      abort.current?.abort();
      abort.current = undefined;
    },
    [],
  );

  return {
    text,
    events,
    result,
    approvals,
    status,
    error,
    /** The conversation `send` will continue, or undefined when the next run starts fresh. */
    session,
    /** Same as `session?.id`. */
    sessionId: session?.id,
    send,
    approve,
    cancel,
    newConversation: reset,
  };
}
