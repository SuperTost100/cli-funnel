import react from "@vitejs/plugin-react";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: { __SANDBOX__: JSON.stringify(join(homedir(), "cli-funnel-playground")) },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4747" } },
});
