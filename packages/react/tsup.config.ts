import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["react", "cli-funnel"],
  // The hooks need the client runtime. Without this, a Next.js Server Component that imports the package fails.
  banner: { js: '"use client";' },
});
