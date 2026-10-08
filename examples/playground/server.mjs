// Local test server for the playground. Binds to 127.0.0.1 and only lets runs use folders inside your home directory.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFunnel } from "cli-funnel";
import { createHandler, serveNode } from "cli-funnel/server";

const sandbox = join(homedir(), "cli-funnel-playground");
mkdirSync(sandbox, { recursive: true });

// OpenAI-compatible servers, as JSON: [{"id":"lmstudio","name":"LM Studio","baseUrl":"http://127.0.0.1:1234/v1"}]
const openaiCompatible = process.env.CLI_FUNNEL_OPENAI_COMPATIBLE ? JSON.parse(process.env.CLI_FUNNEL_OPENAI_COMPATIBLE) : undefined;

// Host names to accept besides localhost, comma-separated, for example a tailnet name. Anyone who can reach them can run agents.
const allowedHosts = process.env.CLI_FUNNEL_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);

const handler = createHandler(createFunnel({ openaiCompatible }), { basePath: "/api/funnel", fsRoots: [homedir()], allowedHosts });
const { url } = await serveNode(handler, { port: 4747 });
console.log(`funnel server on ${url}  (default project folder: ${sandbox})`);
