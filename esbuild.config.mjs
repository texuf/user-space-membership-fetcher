import { build } from "esbuild";
import { wasmLoader } from "esbuild-plugin-wasm";

build({
  entryPoints: [
    "./src/user-space-memberships.ts",
    "./src/stream-info.ts",
    "./src/get-stream.ts",
    "./src/space-info.ts",
    "./src/token.ts",
    "./src/permissions.ts",
    "./src/user-inbox.ts",
  ],
  bundle: true,
  sourcemap: "inline",
  platform: "node",
  target: "node20",
  format: "cjs",
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  plugins: [wasmLoader()],
  ignoreAnnotations: true,
  assetNames: "[name]",
  loader: {
    ".ts": "ts",
    ".wasm": "file",
  },
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
