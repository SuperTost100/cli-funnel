// Live end-to-end test. Spends a few tokens per provider on the cheapest model.
// Usage: npm run e2e [-- claude codex]   (no argument runs every provider)
// Uses real logins. It never runs login, logout or update.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFunnel } from "../packages/cli-funnel/dist/index.js";
import { createClient } from "../packages/cli-funnel/dist/client/index.js";
import { createHandler, serveNode } from "../packages/cli-funnel/dist/server/index.js";

const CHEAP = {
  claude: { model: "claude-haiku-4-5-20251001" },
  codex: { model: "gpt-6-luna", effort: "low" },
  agent: { model: "gpt-5.4-nano" },
  antigravity: { model: "gemini-3.8-flash", effort: "low" },
};
const only = process.argv.slice(2);
const providers = Object.keys(CHEAP).filter((p) => !only.length || only.includes(p));

const root = join(homedir(), "cli-funnel-playground", `e2e-${Date.now()}`);
mkdirSync(root, { recursive: true });
const funnel = createFunnel();
const rows = [];
const TIMEOUT = 180_000;

async function check(provider, name, fn) {
  const t0 = Date.now();
  try {
    const note = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT))]);
    rows.push({ provider, name, status: "PASS", note: note ?? "", ms: Date.now() - t0 });
  } catch (e) {
    const skip = e?.skip;
    rows.push({ provider, name, status: skip ? "SKIP" : "FAIL", note: String(e?.message ?? e).split("\n")[0].slice(0, 140), ms: Date.now() - t0 });
  }
  const r = rows.at(-1);
  console.log(`${r.status.padEnd(5)} ${provider.padEnd(12)} ${name.padEnd(34)} ${(r.ms / 1000).toFixed(1)}s ${r.note}`);
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const skip = (msg) => Object.assign(new Error(msg), { skip: true });

const sel = (provider, access, cwd) => ({ provider, ...CHEAP[provider], cwd, access });
const dir = (provider, label) => {
  const d = join(root, `${provider}-${label}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const WRITE = (file) => `Create a file named ${file} in the current directory containing exactly the word hello. Use your file-writing tool. Reply "done" when finished.`;

for (const provider of providers) {
  const p = funnel.providers[provider];
  const cap = p.capabilities;

  await check(provider, "installed and within tested range", async () => {
    const i = await p.detect();
    assert(i.installed, "not installed");
    return `${i.version}${i.withinTestedRange === false ? " (outside range)" : ""}`;
  });

  await check(provider, "signed in", async () => {
    const a = await p.authStatus();
    assert(a.loggedIn, "signed out");
    return [a.method, a.plan].filter(Boolean).join(", ");
  });

  await check(provider, "cheapest model is listed", async () => {
    const models = await p.models();
    const m = models.find((x) => x.id === CHEAP[provider].model);
    assert(m, `${CHEAP[provider].model} missing from ${models.length} models`);
    if (CHEAP[provider].effort) assert(m.efforts.some((e) => e.id === CHEAP[provider].effort), "effort not offered");
    return `${models.length} models`;
  });

  const fullAccess = cap.access.includes("full") ? "full" : cap.access[0];

  await check(provider, "run returns text and usage", async () => {
    const r = await funnel.run({ selection: sel(provider, fullAccess, dir(provider, "text")), prompt: "Reply with exactly: e2e ok" });
    assert(/e2e ok/i.test(r.text), `text was "${r.text.slice(0, 60)}"`);
    assert(r.finishReason === "stop", `finishReason ${r.finishReason}`);
    assert(r.sessionId, "no sessionId");
    assert(r.usage && r.usage.totalTokens > 0, "no usage");
    return `${r.usage.totalTokens} tokens`;
  });

  await check(provider, "stream emits deltas then done", async () => {
    const s = funnel.stream({ selection: sel(provider, fullAccess, dir(provider, "stream")), prompt: "Count from 1 to 5 separated by spaces." });
    const types = [];
    for await (const e of s) types.push(e.type);
    assert(types.includes("session") && types.includes("text.delta") && types.at(-1) === "done", `events: ${[...new Set(types)].join(",")}`);
    const r = await s.result;
    assert(/1\D+2\D+3/.test(r.text), `text "${r.text.slice(0, 40)}"`);
    return `${types.filter((t) => t === "text.delta").length} deltas`;
  });

  await check(provider, "resume keeps the conversation", async () => {
    const cwd = dir(provider, "resume");
    const a = await funnel.run({ selection: sel(provider, fullAccess, cwd), prompt: "Remember this word: pineapple. Reply only: noted" });
    assert(a.sessionId, "no sessionId");
    const b = await funnel.run({ selection: sel(provider, fullAccess, cwd), prompt: "What word did I ask you to remember? Reply with the word only.", sessionId: a.sessionId });
    assert(/pineapple/i.test(b.text), `second answer "${b.text.slice(0, 60)}"`);
  });

  if (cap.access.includes("none")) {
    await check(provider, "none: answers and blocks a write", async () => {
      const cwd = dir(provider, "none");
      const target = join(cwd, "out.txt");
      const r = await funnel.run({ selection: sel(provider, "none", cwd), prompt: `Run the shell command "touch ${target}", then reply "done".` });
      assert(!existsSync(target), "file was written");
      assert(r.text.trim(), "no text");
      return `${r.toolCalls.length} tool calls, ${r.deniedActions.length} denied`;
    });
  }

  for (const access of ["accept-edits", "auto", "full"]) {
    if (!cap.access.includes(access)) continue;
    await check(provider, `${access}: writes a file`, async () => {
      const cwd = dir(provider, access);
      const r = await funnel.run({
        selection: sel(provider, access, cwd),
        prompt: WRITE("out.txt"),
        onApproval: () => "allow",
      });
      const wrote = existsSync(join(cwd, "out.txt")) && /hello/i.test(readFileSync(join(cwd, "out.txt"), "utf8"));
      if (!wrote && r.deniedActions.length) throw skip(`refused by CLI: ${r.deniedActions.join(", ")}`);
      assert(wrote, `file not written; tools: ${r.toolCalls.map((t) => t.name).join(",") || "none"}`);
      return `${r.toolCalls.length} tool calls`;
    });
  }

  if (cap.access.includes("supervised")) {
    await check(provider, "supervised: approve writes the file", async () => {
      const cwd = dir(provider, "sup-allow");
      let asked = 0;
      await funnel.run({ selection: sel(provider, "supervised", cwd), prompt: WRITE("out.txt"), onApproval: () => (asked++, "allow") });
      assert(asked > 0, "onApproval never called");
      assert(existsSync(join(cwd, "out.txt")), "file missing after allow");
      return `${asked} approval(s)`;
    });
    await check(provider, "supervised: deny blocks the write", async () => {
      const cwd = dir(provider, "sup-deny");
      let asked = 0;
      await funnel.run({ selection: sel(provider, "supervised", cwd), prompt: WRITE("out.txt"), onApproval: () => (asked++, "deny") });
      assert(asked > 0, "onApproval never called");
      assert(!existsSync(join(cwd, "out.txt")), "file exists after deny");
      return `${asked} denial(s)`;
    });
  } else {
    await check(provider, "supervised is rejected up front", async () => {
      try {
        await funnel.run({ selection: sel(provider, "supervised", dir(provider, "rej")), prompt: "hi", onApproval: () => "allow" });
      } catch (e) {
        assert(e.code === "invalid-selection", `code ${e.code}`);
        return "invalid-selection";
      }
      throw new Error("did not throw");
    });
  }

  await check(provider, "unknown model is rejected", async () => {
    try {
      await funnel.run({ selection: { ...sel(provider, fullAccess, root), model: "not-a-model" }, prompt: "hi" });
    } catch (e) {
      assert(e.code === "invalid-selection", `code ${e.code}`);
      return;
    }
    throw new Error("did not throw");
  });
}

// HTTP layer: OpenAI-compatible endpoint and /run approvals, through the real server and client.
const { server, url } = await serveNode(createHandler(funnel, { fsRoots: [homedir()], openai: { cwd: root, access: "full" } }), { port: 0 });
const client = createClient({ baseUrl: url });

for (const provider of providers) {
  await check(provider, "HTTP /v1/chat/completions", async () => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${provider}/${CHEAP[provider].model}`, reasoning_effort: CHEAP[provider].effort, messages: [{ role: "user", content: "Reply with exactly: http ok" }] }),
    });
    const body = await res.json();
    assert(res.ok, body.error?.message ?? `HTTP ${res.status}`);
    assert(/http ok/i.test(body.choices[0].message.content), `content "${body.choices[0].message.content.slice(0, 50)}"`);
    assert(body.usage?.total_tokens > 0, "no usage");
  });

  await check(provider, "HTTP /v1 streaming ends with [DONE]", async () => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${provider}/${CHEAP[provider].model}`, reasoning_effort: CHEAP[provider].effort, stream: true, messages: [{ role: "user", content: "Reply with exactly: sse ok" }] }),
    });
    const text = await res.text();
    assert(text.includes('"content"') && text.trim().endsWith("[DONE]"), "no content chunks or missing [DONE]");
  });
}

for (const provider of providers.filter((p) => funnel.providers[p].capabilities.access.includes("supervised"))) {
  await check(provider, "HTTP /run approval round trip", async () => {
    const cwd = dir(provider, "http-sup");
    let runId;
    let approved = 0;
    for await (const e of client.run({ selection: sel(provider, "supervised", cwd), prompt: WRITE("out.txt") })) {
      if (e.type === "run") runId = e.runId;
      if (e.type === "approval.request") {
        await client.approve(runId, e.request.id, "allow");
        approved++;
      }
    }
    assert(approved > 0, "no approval.request reached the client");
    assert(existsSync(join(cwd, "out.txt")), "file missing after approving over HTTP");
    return `${approved} approval(s)`;
  });
}

await check("server", "rejects a folder outside allowed roots", async () => {
  const res = await fetch(`${url}/run`, { method: "POST", body: JSON.stringify({ selection: { provider: providers[0], model: "x", cwd: "/etc", access: "full" }, prompt: "hi" }) });
  assert(res.status === 403, `status ${res.status}`);
});

server.close();

const fail = rows.filter((r) => r.status === "FAIL");
const skipped = rows.filter((r) => r.status === "SKIP");
console.log(`\n${rows.length - fail.length - skipped.length} passed, ${skipped.length} skipped, ${fail.length} failed. Test files are in ${root}`);
process.exit(fail.length ? 1 : 0);
