import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AuthStatus,
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

/** Loads installed providers and their login state. */
export function useProviders(client: FunnelClient) {
  const [providers, setProviders] = useState<ProviderOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      setProviders(await client.providers());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);
  useEffect(() => void refresh(), [refresh]);
  return { providers, loading, error, refresh };
}

/**
 * Holds a Selection and keeps it valid. Change the provider and the model, effort, context,
 * fast and access fall back to values that provider supports. `locked` fields never change.
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
  const { providers, loading: loadingProviders, error, refresh } = useProviders(client);
  const [loaded, setLoaded] = useState<{ provider: string; models: ModelInfo[] }>();
  const [draft, setDraft] = useState<Partial<Selection>>({ ...opts.defaults, ...opts.locked });
  const locked = opts.locked ?? {};

  const providerId = draft.provider ?? providers.find((p) => p.installation.installed && p.auth?.loggedIn)?.id ?? providers.find((p) => p.installation.installed)?.id;
  const overview = providers.find((p) => p.id === providerId);

  // Only trust a model list that belongs to the current provider. Right after a switch the old list is still in state.
  const models = useMemo(() => (loaded && loaded.provider === providerId ? loaded.models : []), [loaded, providerId]);

  useEffect(() => {
    if (!providerId) return;
    let live = true;
    client.models(providerId).then((m) => live && setLoaded({ provider: providerId, models: m }), () => live && setLoaded({ provider: providerId, models: [] }));
    return () => {
      live = false;
    };
  }, [client, providerId]);

  const selection = useMemo<Partial<Selection>>(() => {
    if (!providerId || !overview) return { ...draft, ...locked };
    const cap = overview.capabilities;
    const picked = opts.pick?.(providerId, models);
    const model = models.find((m) => m.id === draft.model) ?? models.find((m) => m.id === picked?.model) ?? models[0];
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
  }, [draft, models, overview, providerId, locked, opts.pick]);

  const set = useCallback(
    (patch: Partial<Selection>) =>
      setDraft((d) => {
        // A new provider brings its own models, so nothing tied to the old model carries over.
        const switching = patch.provider !== undefined && patch.provider !== d.provider;
        return { ...d, ...(switching ? { model: undefined, effort: undefined, contextWindow: undefined, fast: undefined } : {}), ...patch };
      }),
    [],
  );
  const complete = !!(selection.provider && selection.model && selection.cwd && selection.access);

  return {
    providers,
    models,
    overview,
    model: models.find((m) => m.id === selection.model),
    selection,
    /** A full Selection once provider, model, folder and access are all set. */
    value: complete ? (selection as Selection) : undefined,
    set,
    loading: loadingProviders,
    error,
    refresh,
  };
}

/** Sign-in, sign-out and one-click update for one provider. */
export function useAuth(client: FunnelClient, provider: Selection["provider"], onChange?: () => void) {
  const [status, setStatus] = useState<AuthStatus>();
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [busy, setBusy] = useState<"login" | "update" | "logout">();
  const [message, setMessage] = useState<string>();
  const loginId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    setStatus(await client.authStatus(provider).catch(() => ({ loggedIn: false })));
  }, [client, provider]);
  useEffect(() => void refresh(), [refresh]);

  const login = useCallback(async () => {
    setBusy("login");
    setEvents([]);
    abort.current = new AbortController();
    try {
      for await (const e of client.login(provider, abort.current.signal)) {
        if (e.type === "login") loginId.current = e.loginId;
        else setEvents((prev) => [...prev, e]);
      }
    } catch (e) {
      setEvents((prev) => [...prev, { type: "error", message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(undefined);
      await refresh();
      onChange?.();
    }
  }, [client, provider, refresh, onChange]);

  const sendCode = useCallback((code: string) => loginId.current && client.sendLoginCode(loginId.current, code), [client]);
  const cancel = useCallback(() => {
    if (loginId.current) void client.cancelLogin(loginId.current);
    abort.current?.abort();
  }, [client]);

  const logout = useCallback(async () => {
    setBusy("logout");
    try {
      await client.logout(provider);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
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
      setMessage(e instanceof Error ? e.message : String(e));
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
  const runId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);

  const send = useCallback(
    async (prompt: string, selection: Selection, options: RunOptions = {}) => {
      abort.current = new AbortController();
      setText("");
      setEvents([]);
      setApprovals([]);
      setError(undefined);
      setStatus("running");
      try {
        // A session belongs to one provider and folder. Resuming it anywhere else fails inside the CLI.
        const resume = session && session.provider === selection.provider && session.cwd === selection.cwd ? session.id : undefined;
        for await (const e of client.run({ ...options, prompt, selection, sessionId: resume }, abort.current.signal)) {
          if (e.type === "run") {
            runId.current = e.runId;
            continue;
          }
          setEvents((prev) => [...prev, e]);
          if (e.type === "text.delta") setText((t) => t + e.text);
          else if (e.type === "session") setSession({ id: e.sessionId, provider: selection.provider, cwd: selection.cwd });
          else if (e.type === "approval.request") setApprovals((a) => [...a, e.request]);
          else if (e.type === "error") {
            setError(e.message);
            setStatus("error");
          }
        }
        setStatus((s) => (s === "error" ? s : "done"));
      } catch (e) {
        if (!abort.current.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        } else setStatus("done");
      }
    },
    [client, session],
  );

  const approve = useCallback(
    async (id: string, decision: ApprovalDecision) => {
      setApprovals((a) => a.filter((r) => r.id !== id));
      if (runId.current) await client.approve(runId.current, id, decision);
    },
    [client],
  );

  const result = useMemo(() => {
    const out = { text: "", sessionId: undefined as string | undefined, model: undefined as string | undefined, usage: undefined as Usage | undefined, finishReason: undefined as string | undefined, toolCalls: [] as { id: string; name: string; input?: unknown; error?: string }[] };
    for (const e of events) {
      if (e.type === "session") {
        out.sessionId = e.sessionId;
        out.model = e.model ?? out.model;
      } else if (e.type === "text.delta") out.text += e.text;
      else if (e.type === "tool.start") out.toolCalls.push({ id: e.id, name: e.name, input: e.input });
      else if (e.type === "tool.end") {
        const call = out.toolCalls.find((c) => c.id === e.id);
        if (call && e.error) call.error = e.error;
      } else if (e.type === "usage") out.usage = e.usage;
      else if (e.type === "done") out.finishReason = e.finishReason;
    }
    return out;
  }, [events]);

  const cancel = useCallback(() => abort.current?.abort(), []);
  const reset = useCallback(() => setSession(undefined), []);

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
