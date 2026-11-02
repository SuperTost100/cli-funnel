import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { antigravityProvider } from "../src/providers/antigravity/index.js";
import { newTranscript, subagentStarts, transcriptEvents, transcriptPath } from "../src/providers/antigravity/transcript.js";
import { StreamMapper } from "../src/providers/agent/parser.js";
import { createMapper } from "../src/providers/antigravity/parser.js";
import { buildArgs as agentArgs } from "../src/providers/agent/index.js";
import { threadOptions } from "../src/providers/codex/options.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

const lines = (path: string): unknown[] =>
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

// Recorded from agy 1.4.12: the transcript of the subagent in antigravity/subagent.ndjson. Paths and user names are replaced.
describe("Antigravity subagent transcripts", () => {
  const PARENT = "7acccbcf-1d8e-4eea-bd45-44bb3f304901:4";
  const CONV = "f04d30ef-8e83-4be8-817e-af407ec95f48";
  const transcript = () => lines("antigravity/subagent-transcript.jsonl");

  it("finds the subagent's conversation in the invoke_subagent step, and refuses an id that is not one", () => {
    const starts = lines("antigravity/subagent.ndjson").flatMap(subagentStarts);
    expect(starts).toEqual([{ parentId: PARENT, conversationId: CONV, agent: "self" }]);
    const step = { event: "step_update", step_update: { conversation_id: "c", step_index: 1, state: "DONE", step_type: "subagent", subagent_info: { subagents: [{ conversation_id: "../../etc" }] } } };
    expect(subagentStarts(step)).toEqual([]);
    expect(transcriptPath("/b", CONV)).toBe(join("/b", CONV, ".system_generated", "logs", "transcript.jsonl"));
  });

  it("turns the transcript into tool calls and text tagged with the invoke_subagent call", () => {
    const state = newTranscript({ parentId: PARENT, conversationId: CONV, agent: "self" });
    const events = [...transcript(), transcript()[1], "not a step", { step_index: 99, type: "SOMETHING_NEW", status: "DONE" }].flatMap((l) =>
      transcriptEvents(state, l, { text: true, tools: true }),
    );
    const tag = { parentId: PARENT, agent: "self" };
    expect(events.map((e) => [e.type, (e as { name?: string }).name])).toEqual([
      ["tool.start", "run_command"],
      ["tool.end", undefined],
      ["tool.start", "run_command"],
      ["tool.end", undefined],
      ["tool.start", "send_message"],
      ["tool.end", undefined],
      ["subagent.text", undefined],
    ]);
    expect(events[0]).toEqual({ type: "tool.start", id: `${CONV}:1:0`, name: "run_command", input: { CommandLine: "ls -la", WaitMsBeforeAsync: 5000, toolSummary: "List directory contents" }, ...tag });
    expect(events[3]).toEqual({ type: "tool.end", id: `${CONV}:3:0`, output: expect.stringContaining("a.txt\r\nb.txt"), ...tag });
    expect(events.at(-1)).toEqual({ type: "subagent.text", text: "I have checked the current directory and sent the list of files (`a.txt`, `b.txt`) back to the caller agent.", ...tag });
  });

  it("gives only what was asked for", () => {
    const only = (forward: { text?: boolean; tools?: boolean }) => {
      const state = newTranscript({ parentId: PARENT, conversationId: CONV });
      return transcript().flatMap((l) => transcriptEvents(state, l, forward)).map((e) => e.type);
    };
    expect(only({ text: true })).toEqual(["subagent.text"]);
    expect(only({ tools: true })).not.toContain("subagent.text");
    expect(only({})).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("Antigravity subagent transcripts in a run", () => {
  let home: string | undefined;
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
    if (home !== undefined) process.env.HOME = home;
  });

  /** A fake agy that starts a subagent, writes its transcript in two parts while the run goes on, then ends. */
  const runWith = async (providerOptions: RunInput["providerOptions"], write = true) => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-sub-"));
    home = process.env.HOME;
    process.env.HOME = dir;
    const stream = readFileSync(new URL("./fixtures/antigravity/subagent.ndjson", import.meta.url), "utf8").split("\n").filter(Boolean);
    const startAt = stream.findIndex((l) => l.includes('"step_type":"subagent"'));
    const steps = readFileSync(new URL("./fixtures/antigravity/subagent-transcript.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
    const logs = join(dir, ".gemini", "antigravity-cli", "brain", "f04d30ef-8e83-4be8-817e-af407ec95f48", ".system_generated", "logs");
    const put = (name: string, text: string) => writeFileSync(join(dir, name), text);
    put("head.ndjson", stream.slice(0, startAt + 1).join("\n") + "\n");
    put("mid.ndjson", JSON.stringify({ event: "step_update", step_update: { conversation_id: "7acccbcf-1d8e-4eea-bd45-44bb3f304901", step_index: 5, state: "ACTIVE", step_type: "agent_response", text_delta: "between" } }) + "\n");
    put("tail.ndjson", stream.slice(startAt + 1).filter((l) => !l.includes('"step_index":5,')).join("\n") + "\n");
    put("t1.jsonl", steps.slice(0, 5).join("\n") + "\n");
    // The last step has no line break, as if agy were still writing when the run ended.
    put("t2.jsonl", steps.slice(5).join("\n"));
    const writes = write ? `mkdir -p '${logs}'; cat '${dir}/t1.jsonl' > '${logs}/transcript.jsonl'` : ":";
    const more = write ? `cat '${dir}/t2.jsonl' >> '${logs}/transcript.jsonl'` : ":";
    const bin = join(dir, "agy");
    writeFileSync(bin, `#!/bin/sh\ncat '${dir}/head.ndjson'\n${writes}\nsleep 1.2\ncat '${dir}/mid.ndjson'\n${more}\ncat '${dir}/tail.ndjson'\n`);
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    const events: FunnelEvent[] = [];
    for await (const e of antigravityProvider.run({ selection: { provider: "antigravity", model: "m", cwd: dir, access: "full" }, prompt: "hi", providerOptions })) events.push(e);
    return events;
  };

  it("reads the transcript while the subagent runs and once more at the end", async () => {
    const events = await runWith({ antigravity: { forwardSubagentText: true, forwardSubagentTools: true } });
    const sub = events.filter((e) => "parentId" in e);
    expect(sub.map((e) => e.type)).toEqual(["tool.start", "tool.end", "tool.start", "tool.end", "tool.start", "tool.end", "subagent.text"]);
    // The first part was read while agy was still running, before the text it printed after a pause.
    const between = events.findIndex((e) => e.type === "text.delta" && e.text === "between");
    expect(events.indexOf(sub[0]!)).toBeLessThan(between);
    // The last part, without its line break, came in the final read before the run ended.
    expect(events.indexOf(sub.at(-1)!)).toBeLessThan(events.findIndex((e) => e.type === "done"));
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("emits nothing from the transcript without the options", async () => {
    const events = await runWith(undefined);
    expect(events.some((e) => "parentId" in e)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("finishes the run as usual when the transcript is missing", async () => {
    const events = await runWith({ antigravity: { forwardSubagentText: true, forwardSubagentTools: true } }, false);
    expect(events.some((e) => "parentId" in e)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});
