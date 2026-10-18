import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ECHARTS_MAX = 650_000;
const DIST_MAX = 1_600_000;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(scriptDir, "..", "dist");

if (!existsSync(distDir)) {
  console.error("ERROR: dist/ not found — run 'npm run build' first");
  process.exit(1);
}

let echartsBytes = 0;
let distBytes = 0;
let echartsChunkCount = 0;

function walkDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full);
    else {
      const size = statSync(full).size;
      distBytes += size;
      if (entry.name.startsWith("echarts-") && entry.name.endsWith(".js")) {
        echartsBytes += size;
        echartsChunkCount++;
      }
    }
  }
}
walkDir(distDir);

console.log(`echarts chunk: ${echartsBytes} bytes / budget ${ECHARTS_MAX} (over by ${Math.max(0, echartsBytes - ECHARTS_MAX)})`);
console.log(`dist total: ${distBytes} bytes / budget ${DIST_MAX} (over by ${Math.max(0, distBytes - DIST_MAX)})`);

if (echartsChunkCount !== 1) {
  console.error(`ERROR: expected exactly 1 echarts chunk, found ${echartsChunkCount}`);
  process.exit(1);
}
if (echartsBytes > ECHARTS_MAX || distBytes > DIST_MAX) process.exit(1);
console.log("OK");
