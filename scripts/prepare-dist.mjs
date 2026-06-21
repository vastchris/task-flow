import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const outputDir = join("dist", "task-flow");
const files = ["manifest.json", "styles.css"];

await mkdir(outputDir, { recursive: true });

for (const file of files) {
  await copyFile(join("src", "v2", "plugin", file), join(outputDir, file));
}
