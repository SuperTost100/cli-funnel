import { useState } from "react";
import { createClient } from "cli-funnel/client";
import { ApprovalPrompt, FunnelLogin, FunnelPickerView, FunnelTranscript, useRun, useSelection } from "cli-funnel-react";
import { PatchBay } from "./PatchBay";

declare const __SANDBOX__: string;

const client = createClient({ baseUrl: "/api/funnel" });

const CHEAPEST: Record<string, string> = {
  claude: "claude-haiku-4-5-20251001",
  codex: "gpt-6-luna",
  agent: "gpt-5.4-nano",
  antigravity: "gemini-3.8-flash",
};
const CHEAP_EFFORT: Record<string, string> = { codex: "low", antigravity: "low" };

export function App() {
  const state = useSelection(client, {
    defaults: { cwd: __SANDBOX__, access: "supervised" },
    pick: (provider) => ({ model: CHEAPEST[provider], effort: CHEAP_EFFORT[provider] }),
  });
  const run = useRun(client, { keepTranscript: true });
  const [prompt, setPrompt] = useState("Reply with exactly: funnel ok");
  const { selection, providers } = state;
  const continuing = run.session && run.session.provider === selection.provider && run.session.cwd === selection.cwd ? run.session : undefined;

  const running = run.status === "running";

  return (
    <div className="bench">
      <header className="top">
        <h1>cli-funnel</h1>
        <p>Test bench. Runs here use your real CLI logins. The cheapest model is preselected for each provider.</p>
      </header>

      <PatchBay providers={providers} selected={selection.provider} running={running} onSelect={(provider) => state.set({ provider })} />

      <div className="cols">
        <section className="panel" aria-labelledby="setup">
          <h2 id="setup">Settings</h2>
          <FunnelPickerView client={client} state={state} />
          <p className="hint">
            Default folder is <code>{__SANDBOX__}</code>. Runs may still use any folder under your home directory, because the
            playground server allows the whole home directory. To narrow it, change <code>fsRoots</code> in <code>server.mjs</code>.
          </p>

          <h2>Accounts</h2>
          <div className="accounts">
            {providers.filter((p) => p.capabilities.access.length > 0).map((p) => (
              <FunnelLogin key={p.id} client={client} provider={p} onChange={state.refresh} />
            ))}
          </div>
        </section>

        <section className="panel" aria-labelledby="run">
          <h2 id="run">Run</h2>
          <label className="stack">
            <span>Prompt</span>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} />
          </label>
          <div className="actions">
            <button className="primary" disabled={!state.value || running || !prompt.trim()} onClick={() => state.value && run.send(prompt, state.value)}>
              {run.queued !== undefined ? "Queued…" : running ? "Running…" : "Run prompt"}
            </button>
            {running && <button onClick={run.cancel}>Stop</button>}
            {continuing && !running && <button onClick={run.newConversation}>New conversation</button>}
            {continuing && <span className="mono muted">continuing {continuing.id.slice(0, 8)}</span>}
          </div>

          {run.approvals.map((r) => (
            <ApprovalPrompt key={r.id} request={r} onDecide={run.approve} />
          ))}

          <h3>Conversation</h3>
          {run.turns.length > 0 ? <FunnelTranscript turns={run.turns} /> : <p className="hint">Prompts and answers stack up here, one turn each, until you start a new conversation.</p>}

          <h3>Result</h3>
          <pre className="json mono">{run.result.finishReason ? JSON.stringify(run.result, null, 2) : "Same shape from every provider: text, provider, model, usage, sessionId, finishReason, toolCalls, deniedActions, structured."}</pre>
        </section>
      </div>
    </div>
  );
}
