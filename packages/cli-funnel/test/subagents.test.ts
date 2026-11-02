import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StreamMapper } from "../src/providers/agent/parser.js";
import { createMapper } from "../src/providers/antigravity/parser.js";
import { buildArgs as agentArgs } from "../src/providers/agent/index.js";
import { threadOptions } from "../src/providers/codex/options.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

const lines = (path: string) =>
  readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// Recorded from Cursor Agent 2026.10.22 with composer-2.5: one Task subagent that lists two files. Paths are replaced.
describe("Cursor Agent subagents", () => {
  const map = (forwardSubagentText?: boolean) => {
    const m = new StreamMapper({ forwardSubagentText });
    return lines("agent/subagent-task.ndjson").flatMap((l) => m.map(l));
  };
  const TASK = "tool_e98416fb-45d9-449b-a4c5-cdbe95648d5";

  it("shows the Task call as a tool, and the subagent's text only on request", () => {
    const off = map();
    expect(off.filter((e) => e.type === "tool.start").map((e) => (e as { name: string }).name)).toEqual(["getMcpTools", "task"]);
    expect(off.some((e) => e.type === "subagent.text")).toBe(false);
    const on = map(true);
    expect(on.filter((e) => e.type === "subagent.text")).toEqual([{ type: "subagent.text", parentId: TASK, text: "- a.txt\n- b.txt" }]);
    // It comes right after the Task call's end, and the rest reads as before.
    const end = on.findIndex((e) => e.type === "tool.end" && (e as { id: string }).id === TASK);
    expect(on[end + 1]?.type).toBe("subagent.text");
    expect(on.filter((e) => e.type !== "subagent.text")).toEqual(off);
  });

  it("names the subagent type when the call has one", () => {
    const m = new StreamMapper({ forwardSubagentText: true });
    const call = { args: { subagentType: { explore: {} } }, result: { success: { conversationSteps: [{ assistantMessage: { text: "found it" } }, { other: {} }] } } };
    const events = m.map({ type: "tool_call", subtype: "completed", call_id: "t1", tool_call: { taskToolCall: call } });
    expect(events.filter((e) => e.type === "subagent.text")).toEqual([{ type: "subagent.text", parentId: "t1", text: "found it", agent: "explore" }]);
  });

  it("takes forwardSubagentText and refuses a value that is not a boolean", () => {
    const input = (v: unknown): RunInput => ({ selection: { provider: "agent", model: "m", cwd: "/tmp", access: "auto" }, prompt: "x", providerOptions: { agent: { forwardSubagentText: v as boolean } } });
    expect(() => agentArgs(input(true), "m", "/tmp")).not.toThrow();
    expect(() => agentArgs(input("yes"), "m", "/tmp")).toThrow(/forwardSubagentText/);
  });
});

// Recorded from agy with gemini-3.8-flash: one invoke_subagent call. Paths are replaced and the tool list is cut.
describe("Antigravity subagents", () => {
  it("ends the invoke_subagent call and names the subagent it started", () => {
    const m = createMapper();
    const events: FunnelEvent[] = lines("antigravity/subagent.ndjson").flatMap((l) => m.map(l));
    const start = events.find((e) => e.type === "tool.start" && e.name === "invoke_subagent") as { id: string };
    const end = events.find((e) => e.type === "tool.end" && e.id === start.id) as { output: string };
    expect(JSON.parse(end.output)).toEqual([
      {
        type: "self",
        role: "Directory Lister",
        prompt: "Please list all files and directories in the current directory and reply with the exact list of names you found.",
        conversationId: "f04d30ef-8e83-4be8-817e-af407ec95f48",
      },
    ]);
    expect(events.some((e) => "parentId" in e)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("Codex subagent options", () => {
  it("takes the forward options and refuses a value that is not a boolean", () => {
    const input = (o: Record<string, unknown>): RunInput => ({ selection: { provider: "codex", model: "m", cwd: "/tmp", access: "auto" }, prompt: "x", providerOptions: { codex: o } });
    expect(() => threadOptions(input({ forwardSubagentText: true, forwardSubagentTools: true }))).not.toThrow();
    expect(() => threadOptions(input({ forwardSubagentTools: "true" }))).toThrow(/forwardSubagentTools/);
  });
});
