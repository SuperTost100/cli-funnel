"use client";
import { useState } from "react";
import { createClient } from "cli-funnel/client";
import { ApprovalPrompt, FunnelPicker, useRun } from "cli-funnel-react";
import type { Selection } from "cli-funnel/client";
import "cli-funnel-react/styles.css";

const client = createClient({ baseUrl: "/api/funnel", token: process.env.NEXT_PUBLIC_FUNNEL_TOKEN });

export default function Page() {
  const [selection, setSelection] = useState<Selection>();
  const [prompt, setPrompt] = useState("");
  const run = useRun(client);

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", display: "grid", gap: 20 }}>
      <FunnelPicker client={client} defaults={{ access: "supervised" }} onChange={setSelection} />
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} />
      <button disabled={!selection || run.status === "running"} onClick={() => selection && run.send(prompt, selection)}>
        Run
      </button>
      {run.approvals.map((r) => (
        <ApprovalPrompt key={r.id} request={r} onDecide={run.approve} />
      ))}
      <pre style={{ whiteSpace: "pre-wrap" }}>{run.text}</pre>
      {run.error && <p>{run.error}</p>}
    </main>
  );
}
