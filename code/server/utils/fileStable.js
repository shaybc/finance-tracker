import fs from "node:fs/promises";

export async function waitForFileStable(filePath, { stableMs = 1500, pollMs = 400, timeoutMs = 30000 } = {}) {
  const start = Date.now();
  let last = null;

  while (Date.now() - start < timeoutMs) {
    const stat = await fs.stat(filePath);
    const cur = { size: stat.size, mtimeMs: stat.mtimeMs };

    if (last && cur.size === last.size && cur.mtimeMs === last.mtimeMs) {
      // ensure stable for stableMs
      await new Promise((r) => setTimeout(r, stableMs));
      const stat2 = await fs.stat(filePath);
      if (stat2.size === cur.size && stat2.mtimeMs === cur.mtimeMs) return true;
    }

    last = cur;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return false;
}
