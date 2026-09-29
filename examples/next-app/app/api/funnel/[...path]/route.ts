import { createFunnel } from "cli-funnel";
import { createHandler } from "cli-funnel/server";

// Runs programs on this machine. Keep the token secret and only run this where you trust every caller.
const handler = createHandler(createFunnel(), {
  basePath: "/api/funnel",
  token: process.env.FUNNEL_TOKEN,
  fsRoots: [process.env.PROJECTS_DIR ?? process.env.HOME!],
});

export const GET = handler;
export const POST = handler;
