import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The harness checkout. Reports, the spend ledger and `.env` live here. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]!] = value;
  }
  return out;
}

/**
 * Settings come from the process environment, then from `.env` in the harness checkout. Nothing is
 * read from the home directory or any other tool's config.
 */
export function loadEnv(file = path.join(ROOT, ".env")): Record<string, string | undefined> {
  const fromFile = fs.existsSync(file) ? parseDotEnv(fs.readFileSync(file, "utf8")) : {};
  return { ...fromFile, ...process.env };
}
