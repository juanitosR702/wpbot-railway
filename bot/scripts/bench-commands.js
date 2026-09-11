import { router } from "../src/app/bootstrap.js";
import { cleanJid } from "../src/shared/utils/jid.js";

const GROUP = "120363423912748504@g.us";
const SENDER = "57420105691274@s.whatsapp.net";
const BOT = "573126068076@s.whatsapp.net";

const GROUP_METADATA = {
  id: GROUP,
  subject: "Grupo benchmark",
  participants: [
    { id: SENDER, admin: "admin" },
    { id: BOT, admin: "superadmin" },
    { id: "573000000001@s.whatsapp.net" },
    { id: "573000000002@s.whatsapp.net" },
    { id: "573000000003@s.whatsapp.net" },
    { id: "573000000004@s.whatsapp.net" },
    { id: "573000000005@s.whatsapp.net" },
  ],
};

const services = {
  sendMessage: async () => {},
  deleteMessage: async () => {},
  getGroupMetadata: async () => GROUP_METADATA,
  updateGroupSetting: async () => {},
  updateParticipants: async () => {},
  inviteCode: async () => "ABC123",
  revokeInvite: async () => {},
  botJid: BOT,
  botLid: null,
  downloadMedia: async () => Buffer.alloc(0),
};

const COMMANDS = [
  "!ping",
  "!help",
  "!info",
  "!level",
  "!top",
  "!balance",
  "!daily",
  "!work",
  "!coinflip 100",
  "!slots 50",
  "!tagall",
  "!hidetag",
  "!close",
  "!link",
  "!warnings",
  "!warn",
  "!server",
  "!aura",
  "!casino",
  "!del",
];

function makeMessage(text) {
  return {
    key: {
      remoteJid: GROUP,
      participant: SENDER,
      fromMe: false,
      id: "bench-" + Math.random().toString(36).slice(2),
    },
    pushName: "BenchUser",
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const rss = () => process.memoryUsage().rss;

async function main() {
  const rssBefore = rss();
  console.log("=== BENCHMARK 20 COMANDOS ===");
  console.log(`Inicio: RAM ${mb(rssBefore)} MB`);

  const baseCpu = process.cpuUsage();
  const times = [];
  let peakRss = rss();
  let peakHeap = process.memoryUsage().heapUsed;

  for (let i = 0; i < COMMANDS.length; i++) {
    global.gc?.();
    const before = rss();
    const beforeHeap = process.memoryUsage().heapUsed;
    const start = performance.now();
    try {
      const reply = await router.route(makeMessage(COMMANDS[i]), services);
      const elapsed = (performance.now() - start).toFixed(1);
      times.push(elapsed);
      const after = rss();
      const afterHeap = process.memoryUsage().heapUsed;
      peakRss = Math.max(peakRss, after);
      peakHeap = Math.max(peakHeap, afterHeap);
      const delta = (after - before) / 1024 / 1024;
      const type = reply && typeof reply === "object" && reply.text ? "text" : typeof reply;
      console.log(
        `[${String(i + 1).padStart(2)}] ${COMMANDS[i].padEnd(14)} -> ${elapsed.padStart(7)} ms | RAM +${delta.toFixed(1)} MB (${mb(after)} MB) | heap +${((afterHeap - beforeHeap) / 1024 / 1024).toFixed(1)} MB | reply: ${type || "null"}`
      );
    } catch (err) {
      console.log(`[${String(i + 1).padStart(2)}] ${COMMANDS[i].padEnd(14)} -> ERROR: ${err.message}`);
    }
  }

  global.gc?.();
  const cpuTotal = process.cpuUsage(baseCpu);
  const cpuMs = (cpuTotal.user + cpuTotal.system) / 1000;
  const wallMs = performance.now();

  console.log("\n=== RESUMEN ===");
  console.log(`RAM inicial:      ${mb(rssBefore ?? process.memoryUsage().rss)} MB`);
  console.log(`RAM pico:         ${mb(peakRss)} MB`);
  console.log(`RAM final (postGC): ${mb(rss())} MB`);
  console.log(`Heap pico:        ${mb(peakHeap)} MB`);
  console.log(`Tiempo por cmd:   min ${Math.min(...times)} ms | max ${Math.max(...times)} ms | avg ${(times.reduce((a, b) => a + parseFloat(b), 0) / times.length).toFixed(1)} ms`);
  console.log(`CPU total 20 cmds: ${cpuMs.toFixed(0)} ms`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark fallo:", err);
  process.exit(1);
});
