import type { Turn, TurnToolCall } from "./transcript.js";

export interface FunnelTranscriptProps {
  /** `useRun(client, { keepTranscript: true }).turns`. */
  turns: Turn[];
  className?: string;
}

const FINISH_NOTES: Record<string, string> = {
  cancelled: "Stopped before the answer finished.",
  length: "Cut off at the output token limit.",
};

const fmt = (n: number) => n.toLocaleString("en-US");

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** One line for the closed state of a tool call: the first string in its input, such as the command or the path. */
function preview(input: unknown): string {
  const first = typeof input === "string" ? input : input && typeof input === "object" ? Object.values(input).find((v) => typeof v === "string") : undefined;
  const text = typeof first === "string" ? first : input === undefined ? "" : JSON.stringify(input);
  return text.replace(/\s+/g, " ").trim();
}

function ToolCall({ call }: { call: TurnToolCall }) {
  const denied = call.error?.startsWith("denied:");
  const state = call.running ? "running" : denied ? "not allowed" : call.error ? "failed" : "done";
  return (
    <details className="cf-tool" data-state={call.running ? "running" : denied ? "denied" : call.error ? "failed" : "done"}>
      <summary>
        <span className="cf-tool-name cf-mono">{call.name}</span>
        <span className="cf-tool-preview cf-mono">{preview(call.input)}</span>
        <span className="cf-tool-state">{state}</span>
      </summary>
      <div className="cf-tool-body">
        {call.input !== undefined && (
          <>
            <h4>Input</h4>
            <pre className="cf-mono">{asText(call.input)}</pre>
          </>
        )}
        {call.error && (
          <>
            <h4>Error</h4>
            <pre className="cf-mono cf-error">{call.error}</pre>
          </>
        )}
        {call.output && (
          <>
            <h4>Output</h4>
            <pre className="cf-mono">{call.output}</pre>
          </>
        )}
        {call.input === undefined && !call.error && !call.output && <p className="cf-quiet">No details reported.</p>}
      </div>
    </details>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const running = turn.status === "running";
  const meta = [turn.selection.provider, turn.model];
  if (turn.usage) meta.push(`${fmt(turn.usage.inputTokens)} in, ${fmt(turn.usage.outputTokens)} out`);
  if (turn.usage?.costUsd !== undefined) meta.push(`$${turn.usage.costUsd.toFixed(4)}`);
  const note = turn.finishReason ? FINISH_NOTES[turn.finishReason] : undefined;

  return (
    <article className="cf-turn" aria-busy={running}>
      <p className="cf-prompt">{turn.prompt}</p>
      <div className="cf-answer">
        {turn.toolCalls.length > 0 && (
          <div className="cf-tools">
            {turn.toolCalls.map((c) => (
              <ToolCall key={c.id} call={c} />
            ))}
          </div>
        )}
        {turn.text && <p className="cf-text">{turn.text}</p>}
        {running && (
          <p className="cf-quiet" role="status">
            {turn.text ? "Writing…" : turn.toolCalls.some((c) => c.running) ? "Using tools…" : "Waiting for the first token…"}
          </p>
        )}
        {turn.structured !== undefined && (
          <details className="cf-tool">
            <summary>
              <span className="cf-tool-name">Structured answer</span>
            </summary>
            <div className="cf-tool-body">
              <pre className="cf-mono">{asText(turn.structured)}</pre>
            </div>
          </details>
        )}
        {turn.structuredError && <p className="cf-note">{turn.structuredError}</p>}
        {turn.deniedActions.length > 0 && <p className="cf-note">{`Not allowed: ${[...new Set(turn.deniedActions)].join(", ")}.`}</p>}
        {note && <p className="cf-note">{note}</p>}
        {turn.error && (
          <p className="cf-error" role="alert">
            {turn.error}
          </p>
        )}
        <p className="cf-meta cf-mono">{meta.join(" · ")}</p>
      </div>
    </article>
  );
}

/** Renders the turns from `useRun(client, { keepTranscript: true })`: each prompt, its tool calls (collapsed), the answer and a line of provider, model and usage. */
export function FunnelTranscript({ turns, className }: FunnelTranscriptProps) {
  if (turns.length === 0) return null;
  return (
    <section className={`cf cf-transcript ${className ?? ""}`} aria-label="Conversation">
      {turns.map((t) => (
        <TurnView key={t.id} turn={t} />
      ))}
    </section>
  );
}
