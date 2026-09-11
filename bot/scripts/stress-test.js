import { router } from "../src/app/bootstrap.js";
import { LevelsStore } from "../src/infrastructure/storage/levelsStore.js";

const GROUP = "120363423912748504@g.us";
const SENDER = "57420105691274@s.whatsapp.net";
const BOT = "573126068076@s.whatsapp.net";

const MEMBER_COUNT = 500;
const RANKED_COUNT = 1000;

const participants = [
  { id: SENDER, admin: "admin" },
  { id: BOT, admin: "superadmin" },
];
for (let i = 0; i < MEMBER_COUNT; i++) {
  participants.push({ id: `573${String(i).padStart(9, "0")}@s.whatsapp.net` });
}

const GROUP_METADATA = {
  id: GROUP,
  subject: "Grupo stress test",
  participants,
};

const services = {
  sendMessage: async (msg) => {
    let size = 0;
    try {
      size = JSON.stringify(msg).length;
    } catch {}
    lastSentSize = Math.max(lastSentSize, size);
  },
  deleteMessage: async () => {},
  getGroupMetadata: async () => GROUP_METADATA,
  updateGroupSetting: async () => {},
  updateParticipants: async () => {},
  inviteCode: async () => "ABC123",
  revokeInvite: async () => {},
  botJid: BOT,
  botLid: null,
  downloadMedia: async () => Buffer.alloc(0),
  leaveGroup: async () => {},
  shutdown: async () => {},
  restart: async () => {},
};

const HEAVY_COMMANDS = [
  ["!help", 1],
  ["!tagall", 1],
  ["!hidetag", 1],
  ["!top", 1],
  ["!ranking", 1],
  ["!level", 1],
  ["!balance", 1],
  ["!shop", 1],
  ["!daily", 1],
  ["!server", 1],
  ["!echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1],
  ["!sticker", 1],
];

function makeMessage(text) {
  return {
    key: {
      remoteJid: GROUP,
      participant: SENDER,
      fromMe: false,
      id: "stress-" + Math.random().toString(36).slice(2),
    },
    pushName: "StressUser",
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
let lastSentSize = 0;

async function seedLevels() {
  const store = new LevelsStore();
  await store.ready();
  for (let i = 0; i < RANKED_COUNT; i++) {
    const jid = `573${String(i).padStart(9, "0")}@s.whatsapp.net`;
    store.user(GROUP, jid);
  }
  await store.save();
  console.log(`Seeded ${RANKED_COUNT} usuarios en levels`);
}

async function run() {
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const baseCpu = process.cpuUsage();
  let peak = rssBefore;
  let peakHeap = process.memoryUsage().heapUsed;
  const results = [];

  for (const [cmd, reps] of HEAVY_COMMANDS) {
    for (let r = 0; r < reps; r++) {
      global.gc?.();
      const before = process.memoryUsage().rss;
      const start = performance.now();
      try {
        const reply = await router.route(makeMessage(cmd), services);
        const elapsed = (performance.now() - start).toFixed(1);
        const after = process.memoryUsage().rss;
        const afterHeap = process.memoryUsage().heapUsed;
        peak = Math.max(peak, after);
        peakHeap = Math.max(peakHeap, afterHeap);
        const delta = (after - before) / 1024 / 1024;
        let replyLen = 0;
        try {
          if (reply != null) replyLen = JSON.stringify(reply).length;
        } catch {}
        if (replyLen > lastSentSize) lastSentSize = replyLen;
        results.push({ cmd, elapsed, delta, replyLen });
        console.log(`${cmd.padEnd(70)} ${elapsed.padStart(8)} ms | RAM +${delta.toFixed(1)} MB (${mb(after)}) | reply ${replyLen} chars`);
      } catch (err) {
        results.push({ cmd, elapsed: "ERR", delta: 0, replyLen: 0 });
        console.log(`${cmd.padEnd(70)} ERROR: ${err.message}`);
      }
    }
  }

  global.gc?.();
  const cpu = process.cpuUsage(baseCpu);
  const times = results.filter((r) => r.elapsed !== "ERR").map((r) => parseFloat(r.elapsed));

  console.log("\n=== RESUMEN STRESS ===");
  console.log(`Escenario: grupo de ${MEMBER_COUNT} miembros, ${RANKED_COUNT} usuarios en ranking`);
  console.log(`RAM inicial: ${mb(rssBefore)} MB | RAM pico: ${mb(peak)} MB (+${mb(peak - rssBefore)} MB)`);
  console.log(`Heap pico: ${mb(peakHeap)} MB`);
  console.log(`CPU total: ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms`);
  console.log(`Tiempo/cmd: min ${Math.min(...times)} ms | max ${Math.max(...times)} ms | avg ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)} ms`);
  console.log(`Mayor mensaje enviado: ${(lastSentSize / 1024).toFixed(1)} KB (limite WhatsApp ~64 KB)`);

  const top3 = [...results].filter((r) => r.elapsed !== "ERR").sort((a, b) => parseFloat(b.elapsed) - parseFloat(a.elapsed)).slice(0, 3);
  console.log("\nTOP 3 comandos mas pesados:");
  top3.forEach((r, i) => console.log(`  ${i + 1}. ${r.cmd.trim().slice(0, 40)}: ${r.elapsed} ms, RAM +${r.delta.toFixed(1)} MB, reply ${r.replyLen} chars`));

  process.exit(0);
}

(async () => {
  await seedLevels();
  await run();
})().catch((err) => {
  console.error("Stress test fallo:", err);
  process.exit(1);
});
