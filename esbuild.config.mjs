import { build } from "esbuild";
import { wasmLoader } from "esbuild-plugin-wasm";

build({
  entryPoints: [
    "./src/user.ts",
    "./src/stream.ts",
    "./src/get-stream.ts",
    "./src/space.ts",
    "./src/token.ts",
    "./src/permissions.ts",
    "./src/user-inbox.ts",
    "./src/tips.ts",
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
