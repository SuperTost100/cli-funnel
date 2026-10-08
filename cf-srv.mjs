import { createFunnel } from "./packages/cli-funnel/dist/index.js";
import { createHandler, serveNode } from "./packages/cli-funnel/dist/server/index.js";
await serveNode(createHandler(createFunnel()), { port: 4799 });
