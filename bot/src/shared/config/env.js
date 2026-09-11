import { existsSync, readFileSync } from "fs";

let cachedEnv = null;

export function readEnvFile() {
  if (cachedEnv) return cachedEnv;
  const values = {};
  for (const path of [".env", "../.env"]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && values[key] === undefined) values[key] = value;
    }
  }
  cachedEnv = values;
  return values;
}

export function env(name, fallback = "") {
  return process.env[name] ?? readEnvFile()[name] ?? fallback;
}

export function envNumber(name, fallback) {
  const raw = env(name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
