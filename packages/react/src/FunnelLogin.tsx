import { useState } from "react";
import type { FunnelClient, ProviderOverview } from "cli-funnel/client";
import { useAuth } from "./hooks.js";

export interface FunnelLoginProps {
  client: FunnelClient;
  provider: ProviderOverview;
  /** Called after sign-in, sign-out or update so the parent can refresh its provider list. */
  onChange?: () => void;
  className?: string;
}

/** Status, sign-in, sign-out and one-click CLI update for one provider. */
export function FunnelLogin({ client, provider, onChange, className }: FunnelLoginProps) {
  const a = useAuth(client, provider.id, onChange);
  const [code, setCode] = useState("");
  const install = provider.installation;
  const url = [...a.events].reverse().find((e) => e.type === "open-url");
  const prompt = [...a.events].reverse().find((e) => e.type === "code-prompt");
  const terminal = a.events.find((e) => e.type === "needs-terminal");
  const failure = [...a.events].reverse().find((e) => e.type === "error");

  return (
    <section className={`cf cf-login ${className ?? ""}`}>
      <header>
        <h3>{provider.displayName}</h3>
        <span className="cf-mono">{install.installed ? install.version ?? "installed" : "not installed"}</span>
      </header>

      {!install.installed ? (
        <p>Install the {provider.displayName} CLI, then reload.</p>
      ) : (
        <>
          <p>
            {a.status?.loggedIn
              ? `Signed in${a.status.account ? ` as ${a.status.account}` : ""}${a.status.plan ? `, ${a.status.plan} plan` : ""}.`
              : "Signed out."}
            {install.withinTestedRange === false && " This CLI version is newer or older than the tested range."}
          </p>
          <div className="cf-row">
            {a.status?.loggedIn ? (
              <button type="button" onClick={a.logout} disabled={!!a.busy}>
                Sign out
              </button>
            ) : (
              <button type="button" className="cf-primary" onClick={a.login} disabled={a.busy === "login"}>
                {a.busy === "login" ? "Waiting for sign-in…" : "Sign in"}
              </button>
            )}
            <button type="button" onClick={a.update} disabled={!!a.busy}>
              {a.busy === "update" ? "Updating…" : "Update CLI"}
            </button>
            {a.busy === "login" && (
              <button type="button" onClick={a.cancel}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}

      {url?.type === "open-url" && (
        <p>
          Open <a href={url.url} target="_blank" rel="noreferrer">the sign-in page</a> if it did not open on its own.
        </p>
      )}
      {prompt?.type === "code-prompt" && (
        <form
          className="cf-row"
          onSubmit={(e) => {
            e.preventDefault();
            void a.sendCode(code);
            setCode("");
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code" aria-label="Sign-in code" />
          <button type="submit">Submit</button>
        </form>
      )}
      {terminal?.type === "needs-terminal" && (
        <p>
          This provider signs in from a terminal. Run <code className="cf-mono">{terminal.command.join(" ")}</code>, then come back.
        </p>
      )}
      {failure?.type === "error" && <p className="cf-error">{failure.message}</p>}
      {a.message && <p>{a.message}</p>}
    </section>
  );
}
