import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outputRoot = ".tmp-v2-status-tests";
const outputDir = join(outputRoot, "tests");
const outputFile = join(outputDir, "v2Status.test.mjs");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  entryPoints: ["src/v2/__tests__/v2Status.test.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: outputFile
});

await import(pathToFileURL(outputFile).href);
await rm(outputRoot, { recursive: true, force: true });
