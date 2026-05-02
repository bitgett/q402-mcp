import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  splitting: false,
  sourcemap: false,
  clean: true,
  shims: false,
  banner: { js: "#!/usr/bin/env node" },
  // ethers + MCP SDK kept external so the published bundle stays small;
  // npm/npx resolves them at install time.
  external: ["@modelcontextprotocol/sdk", "ethers", "zod"],
});
