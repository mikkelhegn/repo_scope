import { build } from "esbuild";
import { SpinEsbuildPlugin } from "@spinframework/build-tools/plugins/esbuild/index.js";
import fs from "node:fs";
import path from "node:path";

const spinPlugin = await SpinEsbuildPlugin();

fs.mkdirSync("build", { recursive: true });

await build({
  entryPoints: ["./src/index.ts"],
  outfile: "./build/bundle.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  sourcemap: false,
  minify: false,
  plugins: [spinPlugin],
  logLevel: "error",
  loader: {
    ".ts": "ts",
    ".tsx": "tsx",
  },
  resolveExtensions: [".ts", ".tsx", ".js"],
  sourceRoot: path.resolve(process.cwd(), "src"),
});
