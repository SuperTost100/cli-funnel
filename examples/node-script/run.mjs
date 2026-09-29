// node run.mjs  (after: npm install cli-funnel)
import { createFunnel } from "cli-funnel";

const funnel = createFunnel();

const [claude] = await funnel.models("claude");

const stream = funnel.stream({
  selection: { provider: "claude", model: claude.id, cwd: process.cwd(), access: "supervised" },
  prompt: "List the files in this folder and say what the project does",
  onApproval: async (request) => {
    console.log(`\nApprove ${request.tool}?`, request.input);
    return "allow";
  },
});

for await (const event of stream) {
  if (event.type === "text.delta") process.stdout.write(event.text);
}

console.log("\n", (await stream.result).usage);
