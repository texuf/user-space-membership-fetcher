import { build } from "esbuild";

build({
  entryPoints: {
    getStream: "./src/get-stream.ts",
    permissions: "./src/permissions.ts",
    space: "./src/space.ts",
    stream: "./src/stream.ts",
    tips: "./src/tips.ts",
    token: "./src/token.ts",
    user: "./src/user.ts",
    inbox: "./src/user-inbox.ts",
  },
  bundle: true,
  sourcemap: "inline",
  platform: "node",
  target: "node20",
  format: "cjs",
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  plugins: [],
  external: ["@towns-protocol/olm"],
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
