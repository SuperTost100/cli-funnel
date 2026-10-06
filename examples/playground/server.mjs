// Local test server for the playground. Binds to 127.0.0.1 and only lets runs use folders inside your home directory.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFunnel } from "cli-funnel";
import { createHandler, serveNode } from "cli-funnel/server";

const sandbox = join(homedir(), "cli-funnel-playground");
mkdirSync(sandbox, { recursive: true });

// API providers read ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY. Without a key they show as signed out.
const handler = createHandler(createFunnel({ apiKeys: {} }), { basePath: "/api/funnel", fsRoots: [homedir()] });
const { url } = await serveNode(handler, { port: 4747 });
console.log(`funnel server on ${url}  (default project folder: ${sandbox})`);
