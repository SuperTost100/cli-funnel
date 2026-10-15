import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { renderMessages, toRunInput } from "../src/messages.js";
import { createApiProviders } from "../src/providers/api.js";
import { memoryHistory } from "../src/providers/history.js";
import { createOllamaProvider } from "../src/providers/ollama/index.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Message, Provider, ProviderId, RunInput, RunRequest } from "../src/types.js";

const fx = (dir: string, n: string) => readFileSync(new URL(`./fixtures/${dir}/${n}`, import.meta.url), "utf8");
const IMAGE = { type: "image" as const, mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
const sel = (provider: ProviderId, model = "m-1") => ({ provider, model, cwd: "/tmp", access: "full" as const });

const CHAT: Message[] = [
  { role: "user", content: "What is 2+2?" },
  { role: "assistant", content: "4" },
  { role: "user", content: [{ type: "text", text: "And this?" }, IMAGE] },
];

function stubFetch(body: (url: string) => string, type = "text/event-stream") {
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(body(url), { status: 200, headers: { "content-type": type } });
    }),
  );
  return bodies;
}

const drain = async (it: AsyncIterable<FunnelEvent>) => {
  const out: FunnelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

describe("toRunInput", () => {
  const base = { selection: sel("claude") };

  it("passes a prompt run through unchanged", () => {
    const req: RunRequest = { ...base, prompt: "hi" };
    expect(toRunInput(req)).toBe(req);
  });

  it("renders a transcript and takes the images of the last user message", () => {
    const input = toRunInput({ ...base, messages: CHAT });
    expect(input.prompt).toBe("USER: What is 2+2?\n\nASSISTANT: 4\n\nUSER: And this?");
    expect(input.attachments).toEqual([IMAGE]);
  });

  it("sends only the messages after the last assistant message when resuming", () => {
    const input = toRunInput({ ...base, sessionId: "s", messages: [...CHAT, { role: "user", content: "Quick." }] });
    expect(input.prompt).toBe("And this?\n\nQuick.");
    expect(input.attachments).toEqual([IMAGE]);
  });

  it("uses a single message as the prompt", () => {
    expect(renderMessages([{ role: "user", content: "hi" }], false)).toBe("hi");
  });

  it.each([
    [{ prompt: "x", messages: CHAT }, "not both"],
    [{ messages: CHAT, attachments: [IMAGE] }, "message content"],
    [{ messages: [] }, "non-empty"],
    [{ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }, "end with a user message"],
    [{ messages: [{ role: "system", content: "a" }] }, "system"],
    [{ messages: [{ role: "assistant", content: [IMAGE] }, { role: "user", content: "x" }] }, "only user messages"],
    [{ messages: [{ role: "user", content: [{ type: "image", mediaType: "image/bmp", data: "x" }] }] }, "png"],
    [{ messages: [{ role: "user", content: [{ type: "audio" }] }] }, "text, image, tool_call or tool_result"],
    [{}, "Pass prompt or messages"],
  ])("refuses %j", (extra, message) => {
    expect(() => toRunInput({ ...base, ...(extra as object) } as RunRequest)).toThrow(message);
  });
});

describe("API providers map messages to their own arrays", () => {
  afterEach(() => vi.unstubAllGlobals());
  const api = () => createApiProviders({ anthropic: "k", openai: "k", gemini: "k" });

  it("anthropic: content blocks with the image first as given", async () => {
    const bodies = stubFetch(() => fx("anthropic-api", "omitted.sse"));
    await drain(api()["anthropic-api"].run({ selection: sel("anthropic-api"), prompt: "", messages: CHAT }));
    expect(bodies[0].messages).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: [{ type: "text", text: "And this?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE.data } }] },
    ]);
  });

  it("openai: image_url parts for users and plain text for the assistant", async () => {
    const bodies = stubFetch(() => fx("openai-api", "stream.sse"));
    const messages: Message[] = [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text", text: "b" }, { type: "text", text: "c" }] }, CHAT[2]!];
    await drain(api()["openai-api"].run({ selection: sel("openai-api"), prompt: "", system: "S", messages }));
    expect(bodies[0].messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "a" },
      { role: "assistant", content: "bc" },
      { role: "user", content: [{ type: "text", text: "And this?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE.data}` } }] },
    ]);
  });

  it("gemini: the model role and inlineData parts", async () => {
    const bodies = stubFetch(() => fx("gemini-api", "stream.sse"));
    await drain(api()["gemini-api"].run({ selection: sel("gemini-api"), prompt: "", messages: CHAT }));
    expect(bodies[0].contents).toEqual([
      { role: "user", parts: [{ text: "What is 2+2?" }] },
      { role: "model", parts: [{ text: "4" }] },
      { role: "user", parts: [{ text: "And this?" }, { inlineData: { mimeType: "image/png", data: IMAGE.data } }] },
    ]);
  });

  it("ollama: text in content and images in their own field", async () => {
    const bodies = stubFetch(() => fx("ollama", "chat.ndjson"), "application/x-ndjson");
    await drain(createOllamaProvider({ baseUrl: "http://box:11434" }).run({ selection: sel("ollama"), prompt: "", messages: CHAT }));
    expect(bodies[0].messages).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "And this?", images: [IMAGE.data] },
    ]);
  });
});

describe("messages and session history", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("appends only the new messages to a stored session, and stores the typed turns", async () => {
    const bodies = stubFetch(() => fx("openai-api", "stream.sse"));
    const history = memoryHistory();
    const p = createApiProviders({ openai: "k" })["openai-api"];
    const run = (over: Partial<RunInput>) => drain(p.run({ selection: sel("openai-api"), prompt: "", history, ...over }));
    // A new session id with nothing stored: the whole array is the conversation.
    await run({ sessionId: "s", messages: CHAT });
    expect(bodies[0].messages).toHaveLength(3);
    expect(await history.get("openai-api:s")).toHaveLength(4);
    // The client resends the whole chat. The stored turns stand in for it, so nothing is sent twice.
    await run({ sessionId: "s", messages: [...CHAT, { role: "assistant", content: "Hello." }, { role: "user", content: "next" }] });
    // The stored answer is the fixture's "Hello.", so the stored copy of the chat is what comes first.
    expect(bodies[1].messages).toEqual([...bodies[0].messages, { role: "assistant", content: "Hello." }, { role: "user", content: "next" }]);
    // A prompt continues the same session.
    await run({ sessionId: "s", prompt: "last" });
    expect(bodies[2].messages).toHaveLength(7);
  });
});

describe("funnel and server", () => {
  const seen: RunInput[] = [];
  const recorder = (id: ProviderId, messages: boolean): Provider => ({
    id,
    displayName: id,
    binary: "fake",
    capabilities: { access: [], effort: false, contextWindow: false, fast: false, resume: true, approvals: false, images: true, messages, system: "native", schema: "native" },
    detect: async () => ({ installed: true, testedRange: { min: "0" } }),
    authStatus: async () => ({ loggedIn: true }),
    login: () => {
      throw new Error("no");
    },
    logout: async () => {},
    update: async () => ({ changed: false, output: "" }),
    models: async () => [{ id: "m-1", name: "m", provider: id, efforts: [], contextWindows: [], fast: false, source: "manifest" }],
    async *run(input) {
      seen.push(input);
      yield { type: "text.delta", text: "ok" };
      yield { type: "done", text: "", finishReason: "stop" };
    },
  });
  const funnel = createFunnel({ providers: { claude: recorder("claude", false), "openai-api": recorder("openai-api", true) } });

  it("fills prompt and attachments for a provider without typed turns", async () => {
    seen.length = 0;
    await funnel.run({ selection: sel("claude"), messages: CHAT });
    expect(seen[0]!.prompt).toContain("ASSISTANT: 4");
    expect(seen[0]!.attachments).toEqual([IMAGE]);
  });

  it("rejects a bad request with invalid-selection", async () => {
    await expect(funnel.run({ selection: sel("claude"), messages: [] })).rejects.toMatchObject({ code: "invalid-selection" });
    await expect(funnel.run({ selection: sel("claude") })).rejects.toThrow("Pass prompt or messages");
  });

  const handler = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd: tmpdir() } });
  const chat = (body: object) =>
    handler(new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "openai-api/m-1", ...body }) }));

  it("hands the chat to the run as typed messages, system and developer messages as the system prompt", async () => {
    seen.length = 0;
    const res = await chat({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: [{ type: "text", text: "No markdown." }] },
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: [{ type: "text", text: "And this?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE.data}` } }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(seen[0]!.system).toBe("Be brief.\n\nNo markdown.");
    expect(seen[0]!.messages).toEqual(CHAT);
  });

  it("refuses remote image URLs and unknown roles with a 400", async () => {
    const remote = await chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] });
    expect(remote.status).toBe(400);
    expect((await remote.json()).error.param).toBe("messages[0].content[0]");
    const role = await chat({ messages: [{ role: "function", content: "x" }, { role: "user", content: "y" }] });
    expect(role.status).toBe(400);
  });

  it("answers 400 when the chat does not end with a user message", async () => {
    const res = await chat({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
    expect(res.status).toBe(400);
  });

  it("takes messages on /run", async () => {
    seen.length = 0;
    const res = await handler(new Request("http://x/run", { method: "POST", body: JSON.stringify({ selection: sel("openai-api"), messages: CHAT }) }));
    await res.text();
    expect(seen[0]!.messages).toEqual(CHAT);
  });
});
