import { connection, mode } from "./app/bootstrap.js";
import os from "os";
import { mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { isSessionNoise } from "./infrastructure/bot/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, "../logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "bot.log");

const originalLog = console.log;
const originalWarn = console.warn;
const logToFile = (...args) => {
  if (isSessionNoise(...args)) return;
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.join(" ")}\n`);
  } catch {}
};
console.log = (...args) => {
  originalLog(...args);
  logToFile(...args);
};
console.warn = (...args) => {
  originalWarn(...args);
  logToFile(...args);
};

console.log("[build] prod-d023350-kirk-debug");
const MONITOR_INTERVAL = 10_000;

setInterval(() => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const external = (mem.external / 1024 / 1024).toFixed(1);
  const uptime = (process.uptime() / 60).toFixed(1);
  const cpus = os.cpus();
  const totalCpu = cpus.reduce((s, c) => {
    const idle = c.times.idle;
    const total = Object.values(c.times).reduce((a, b) => a + b, 0);
    return s + (1 - idle / total);
  }, 0);
  const cpuPct = ((totalCpu / cpus.length) * 100).toFixed(1);
  console.log(`[monitor] RAM ${rss} MB (heap ${heap} MB, ext ${external} MB) | CPU ${cpuPct}% | uptime ${uptime} min`);
}, MONITOR_INTERVAL);

if (mode === "cloud") {
  console.log("[index] Solo API oficial (cloud): sin sesión Baileys, esperando webhooks.");
} else {
  await connection.connect();
}
