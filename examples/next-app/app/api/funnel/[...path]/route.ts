import { createFunnel } from "cli-funnel";
import { createHandler } from "cli-funnel/server";

// Runs programs on this machine. Only run this where you trust every caller.
// No token here: the browser client sends none, and a handler with a token answers 401 without one. A token set here
// would also switch off the host check. If others can reach this app, check your own session before calling `handler`.
const handler = createHandler(createFunnel(), {
  basePath: "/api/funnel",
  fsRoots: [process.env.PROJECTS_DIR ?? process.env.HOME!],
});

export const GET = handler;
export const POST = handler;
