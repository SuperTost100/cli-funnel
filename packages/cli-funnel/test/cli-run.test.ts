import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { UsageError, loadImages, loadSchema, renderRun, resolvePrompt, sniffImageType } from "../src/bin/run-input.js";
import type { FunnelEvent, RunResult } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cli-funnel-run-"));
const file = (name: string, content: Buffer | string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n"), Buffer.alloc(8)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a....");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

const tty = (isTTY: boolean) => Object.assign(Readable.from([]), { isTTY });
const piped = (text: string) => Readable.from([Buffer.from(text)]);

describe("resolvePrompt", () => {
  it("joins the words when there are any", async () => {
    expect(await resolvePrompt(["say", "hi"], tty(true))).toBe("say hi");
  });

  it("reads stdin for - and for no words, and drops one trailing newline", async () => {
    expect(await resolvePrompt(["-"], piped("line one\nline two\n"))).toBe("line one\nline two");
    expect(await resolvePrompt([], piped("hello\r\n"))).toBe("hello");
  });

  it("treats - among other words as a word", async () => {
    expect(await resolvePrompt(["a", "-"], tty(true))).toBe("a -");
  });

  it("refuses a terminal instead of waiting for it", async () => {
    await expect(resolvePrompt([], tty(true))).rejects.toThrow(UsageError);
  });

  it("refuses an empty stdin", async () => {
    await expect(resolvePrompt(["-"], piped("\n"))).rejects.toThrow("empty");
  });
});

describe("loadImages", () => {
  it("detects the type from the bytes, not the name", async () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(Buffer.from("hello"))).toBeUndefined();
    expect(sniffImageType(Buffer.alloc(0))).toBeUndefined();
  });

  it("returns base64 attachments in order", async () => {
    const list = await loadImages([file("a.bin", PNG), file("b.png", JPEG)]);
    expect(list).toEqual([
      { type: "image", mediaType: "image/png", data: PNG.toString("base64") },
      { type: "image", mediaType: "image/jpeg", data: JPEG.toString("base64") },
    ]);
    expect(await loadImages([])).toBeUndefined();
    expect(await loadImages(undefined)).toBeUndefined();
  });

  it("names the file in its errors", async () => {
    await expect(loadImages([join(dir, "missing.png")])).rejects.toThrow(/missing\.png: ENOENT/);
    await expect(loadImages([file("notes.png", "text")])).rejects.toThrow(/notes\.png is not a PNG/);
  });
});

describe("loadSchema", () => {
  it("wraps the file as a response schema", async () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(await loadSchema(file("s.json", JSON.stringify(schema)))).toEqual({ schema });
    expect(await loadSchema(undefined)).toBeUndefined();
  });

  it("rejects bad files", async () => {
    await expect(loadSchema(join(dir, "none.json"))).rejects.toThrow(/ENOENT/);
    await expect(loadSchema(file("bad.json", "{"))).rejects.toThrow(/not valid JSON/);
    await expect(loadSchema(file("list.json", "[]"))).rejects.toThrow(/JSON Schema object/);
  });
});

const result = (over: Partial<RunResult> = {}): RunResult => ({
  text: "hello",
  provider: "claude",
  model: "m",
  finishReason: "stop",
  toolCalls: [],
  deniedActions: [],
  ...over,
});

function fakeStream(events: FunnelEvent[], res: RunResult) {
  return Object.assign(
    (async function* () {
      yield* events;
    })(),
    { result: Promise.resolve(res) },
  );
}

async function render(opts: { json?: boolean; quiet?: boolean; schema?: boolean }, res = result()) {
  let stdout = "";
  let stderr = "";
  const events: FunnelEvent[] = [
    { type: "tool.start", id: "1", name: "Read" },
    { type: "text.delta", text: "hel" },
    { type: "text.delta", text: "lo" },
  ];
  const { structured } = await renderRun(fakeStream(events, res), { ...opts, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { ok: structured, stdout, stderr };
}

describe("renderRun", () => {
  it("streams text on stdout by default", async () => {
    const r = await render({});
    expect(r).toEqual({ ok: true, stdout: "hello\n", stderr: "\n[tool] Read\n" });
  });

  it("prints only the result object on stdout with --json", async () => {
    const r = await render({ json: true }, result({ sessionId: "s1" }));
    expect(JSON.parse(r.stdout)).toMatchObject({ text: "hello", sessionId: "s1" });
    expect(r.stderr).toBe("\n[tool] Read\nsession s1\n");
  });

  it("drops the stream with --json --quiet", async () => {
    const r = await render({ json: true, quiet: true });
    expect(JSON.parse(r.stdout).text).toBe("hello");
    expect(r.stderr).toBe("");
  });

  it("writes the final text once with --quiet alone", async () => {
    const r = await render({ quiet: true });
    expect(r).toEqual({ ok: true, stdout: "hello\n", stderr: "" });
  });

  it("prints only the structured answer with --schema", async () => {
    const r = await render({ schema: true }, result({ text: '{"a":1}', structured: { a: 1 } }));
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.stdout)).toEqual({ a: 1 });
    expect(r.stderr).toBe("\n[tool] Read\n");
  });

  it("fails with --schema when the answer is not structured", async () => {
    const r = await render({ schema: true, quiet: true }, result({ structuredError: "text is not JSON" }));
    expect(r).toEqual({ ok: false, stdout: "", stderr: "No structured answer: text is not JSON\n" });
  });

  it("keeps a failed --schema visible in --json output", async () => {
    const r = await render({ json: true, schema: true }, result({ structuredError: "nope" }));
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.stdout).structuredError).toBe("nope");
  });
});
