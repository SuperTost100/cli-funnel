import { useEffect, useId, useState } from "react";
import type { AccessLevel, DirListing, FunnelClient, Selection } from "cli-funnel/client";
import { useSelection } from "./hooks.js";

const ACCESS_LABELS: Record<AccessLevel, { label: string; hint: string }> = {
  none: { label: "No tools", hint: "Answers only. Cannot edit files or run commands" },
  supervised: { label: "Supervised", hint: "Asks before every action" },
  "accept-edits": { label: "Accept edits", hint: "Edits files freely, asks for the rest" },
  auto: { label: "Auto", hint: "A classifier approves safe actions" },
  full: { label: "Full access", hint: "Runs anything without asking" },
};

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`);

export interface FunnelPickerProps {
  client: FunnelClient;
  /** Starting values. The user can change them. */
  defaults?: Partial<Selection>;
  /** Fixed values. These fields are hidden and always applied. Use it to hardcode a choice. */
  locked?: Partial<Selection>;
  /** Called whenever the selection changes. `undefined` until provider, model, folder and access are all set. */
  onChange?: (selection: Selection | undefined) => void;
  className?: string;
}

export type SelectionState = ReturnType<typeof useSelection>;

export function FunnelPicker({ client, defaults, locked, onChange, className }: FunnelPickerProps) {
  const s = useSelection(client, { defaults, locked });
  useEffect(() => onChange?.(s.value), [s.value && JSON.stringify(s.value)]); // eslint-disable-line react-hooks/exhaustive-deps
  return <FunnelPickerView client={client} state={s} locked={locked} className={className} />;
}

/** The picker markup on top of a `useSelection` state you own. Use it when other parts of your UI need the same state. */
export function FunnelPickerView({ client, state: s, locked, className }: { client: FunnelClient; state: SelectionState; locked?: Partial<Selection>; className?: string }) {
  const id = useId();
  const { selection, model, overview } = s;
  const cap = overview?.capabilities;

  if (s.loading) return <div className={`cf ${className ?? ""}`}>Loading providers…</div>;
  if (s.error) return <div className={`cf cf-error ${className ?? ""}`}>{s.error}</div>;

  const installed = s.providers.filter((p) => p.installation.installed);
  const show = (k: keyof Selection) => !(locked && k in locked);

  return (
    <div className={`cf cf-picker ${className ?? ""}`}>
      {show("provider") && (
        <label className="cf-field">
          <span>Provider</span>
          <select value={selection.provider ?? ""} onChange={(e) => s.set({ provider: e.target.value as Selection["provider"] })}>
            {installed.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
                {p.auth?.loggedIn ? "" : " (signed out)"}
              </option>
            ))}
          </select>
          {installed.length === 0 && <small>No supported CLI found. Run “cli-funnel doctor”.</small>}
        </label>
      )}

      {show("model") && (
        <label className="cf-field">
          <span>Model</span>
          <select value={selection.model ?? ""} onChange={(e) => s.set({ model: e.target.value })}>
            {s.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {selection.model && <small className="cf-mono">{selection.model}</small>}
        </label>
      )}

      {cap?.effort && model && model.efforts.length > 0 && show("effort") && (
        <label className="cf-field">
          <span>Reasoning</span>
          <select value={selection.effort ?? ""} onChange={(e) => s.set({ effort: e.target.value })}>
            {model.efforts.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {cap?.contextWindow && model && model.contextWindows.length > 0 && show("contextWindow") && (
        <label className="cf-field">
          <span>Context window</span>
          <select value={selection.contextWindow ?? ""} onChange={(e) => s.set({ contextWindow: Number(e.target.value) })}>
            {model.contextWindows.map((c) => (
              <option key={c} value={c}>
                {fmtTokens(c)} tokens
              </option>
            ))}
          </select>
        </label>
      )}

      {cap?.fast && model?.fast && show("fast") && (
        <label className="cf-check">
          <input type="checkbox" checked={!!selection.fast} onChange={(e) => s.set({ fast: e.target.checked })} />
          <span>Fast mode</span>
          <small>Quicker output, uses your quota faster</small>
        </label>
      )}

      {show("cwd") && <FolderField client={client} value={selection.cwd} onChange={(cwd) => s.set({ cwd })} labelId={id} />}

      {cap && show("access") && (
        <fieldset className="cf-field cf-access">
          <legend>Machine access</legend>
          {cap.access.map((a) => (
            <label key={a} className={selection.access === a ? "cf-option cf-on" : "cf-option"}>
              <input type="radio" name={`${id}-access`} checked={selection.access === a} onChange={() => s.set({ access: a })} />
              <span>{ACCESS_LABELS[a].label}</span>
              <small>{ACCESS_LABELS[a].hint}</small>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function FolderField({ client, value, onChange, labelId }: { client: FunnelClient; value?: string; onChange: (p: string) => void; labelId: string }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirListing>();
  const [err, setErr] = useState<string>();

  const load = (path?: string) =>
    client.listDirs(path).then(
      (l) => {
        setListing(l);
        setErr(undefined);
      },
      (e) => setErr(e instanceof Error ? e.message : String(e)),
    );

  return (
    <div className="cf-field cf-folder">
      <label htmlFor={`${labelId}-cwd`}>Project folder</label>
      <div className="cf-row">
        <input id={`${labelId}-cwd`} className="cf-mono" value={value ?? ""} placeholder="/path/to/project" onChange={(e) => onChange(e.target.value)} />
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
            if (!open) void load(value);
          }}
        >
          Browse
        </button>
      </div>
      {open && (
        <div className="cf-browser" role="listbox" aria-label="Folders">
          {err && <small className="cf-error">{err}</small>}
          {listing && (
            <>
              <div className="cf-crumb cf-mono">{listing.path}</div>
              <div className="cf-list">
                {listing.parent && (
                  <button type="button" onClick={() => load(listing.parent!)}>
                    ..
                  </button>
                )}
                {listing.dirs.map((d) => (
                  <button type="button" key={d} onClick={() => load(`${listing.path}/${d}`)}>
                    {d}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="cf-primary"
                onClick={() => {
                  onChange(listing.path);
                  setOpen(false);
                }}
              >
                Use this folder
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
