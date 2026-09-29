import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server/index.ts", "src/client/index.ts", "src/bin/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node22",
});
