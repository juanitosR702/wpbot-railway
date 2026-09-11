const GROUPS = [
  { label: "BASE", commands: ["!ping", "!help", "!info", "!echo hola mundo", "!hola"] },
  { label: "NIVELES", commands: ["!level", "!top", "!rank", "!ranking", "!aura"] },
  { label: "ECONOMIA", commands: ["!balance", "!bal", "!daily", "!work", "!hunt", "!fish", "!mine", "!crime", "!rob", "!steal", "!scratch", "!shop", "!buy pocion", "!inventory", "!inv", "!dep 100", "!deposit 100", "!wd 50", "!withdraw 50", "!transfer", "!pay"] },
  { label: "CASINO", commands: ["!coinflip 100", "!slots 50", "!dice 25", "!blackjack 50", "!roulette 20", "!hit", "!stand"] },
  { label: "ADMIN", commands: ["!tagall", "!hidetag", "!close", "!open", "!link", "!resetlink", "!promote", "!demote", "!kick", "!add", "!mutechat", "!unmutechat", "!antilink on", "!welcome on", "!setwelcome Bienvenido {user}", "!setbye Adios {user}", "!warn", "!warnings", "!clearwarns"] },
  { label: "MODERACION", commands: ["!del", "!delme", "!blacklist", "!unblacklist", "!mute", "!unmute", "!modlogs", "!kickwarning"] },
  { label: "NSFW", commands: ["!antinsfw on", "!antinsfw off", "!antinsfw status", "!antinsfw mode", "!antinsfw block", "!antinsfw unblock", "!antinsfw blocklist"] },
  { label: "AI", commands: ["!aistatus", "!aireset", "!ai hola", "!ask hola", "!resume", "!resumen"] },
  { label: "MC", commands: ["!server", "!setserver play.example.net", "!cancelserver"] },
  { label: "OWNER", commands: ["!darcoins 100", "!givemoney 100", "!addmoney 100", "!creador", "!owner", "!ownerid", "!protected", "!protegidos", "!botuptime", "!salirgrupo", "!leavegroup", "!botoff", "!apagarbot"] },
  { label: "POLLS", commands: ["!poll si no", "!encuesta si no"] },
  { label: "STICKERS", commands: ["!sticker", "!s", "!stiker", "!toimage", "!img"] },
  { label: "MUSICA", commands: ["!song", "!musica", "!music"] },
];

const ALL_COMMANDS = GROUPS.flatMap((g) => g.commands);

const TOTAL = ALL_COMMANDS.length;

const WA_LIMIT = 64 * 1024;

const STRESS_MEMBERS = 500;

function makeMsg(ctx, text) {
  const raw = ctx.raw;
  return {
    key: {
      remoteJid: raw.key.remoteJid,
      participant: `${ctx.sender}@s.whatsapp.net`,
      fromMe: false,
      id: "bench-" + Math.random().toString(36).slice(2),
    },
    pushName: ctx.name || "BenchUser",
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

function makeStressMetadata(groupId) {
  const participants = [
    { id: `${ctx_sender_stub}`, admin: "admin" },
  ];
  for (let i = 0; i < STRESS_MEMBERS; i++) {
    participants.push({ id: `573${String(i).padStart(9, "0")}@s.whatsapp.net` });
  }
  return {
    id: groupId,
    subject: "Grupo stress",
    participants,
  };
}

const ctx_sender_stub = "57420105691274@s.whatsapp.net";

function mockServices(ctx, stress = false) {
  const real = ctx.services;
  return {
    ...real,
    sendMessage: async () => {},
    deleteMessage: async () => {},
    updateGroupSetting: async () => {},
    updateParticipants: async () => {},
    inviteCode: async () => "BENCH123",
    revokeInvite: async () => {},
    downloadMedia: async () => Buffer.alloc(0),
    leaveGroup: async () => {},
    shutdown: async () => {},
    restart: async () => {},
    getGroupMetadata: stress
      ? async () => makeStressMetadata(ctx.raw.key.remoteJid)
      : real.getGroupMetadata,
  };
}

function replySize(reply) {
  try {
    return reply == null ? 0 : Buffer.byteLength(JSON.stringify(reply));
  } catch {
    return 0;
  }
}

const kb = (bytes) => (bytes / 1024).toFixed(1);

function sizeTag(bytes) {
  if (bytes > WA_LIMIT) return " \u26A0\uFE0F SOBRE LIMITE";
  if (bytes > WA_LIMIT / 2) return " \u{1F7E1} alto";
  return "";
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function runBench(ctx, router, stress) {
  const rssBefore = process.memoryUsage().rss;
  const cpuBase = process.cpuUsage();
  const perCmd = new Map();
  const perSize = new Map();
  let peak = rssBefore;
  let peakHeap = process.memoryUsage().heapUsed;
  const times = [];

  for (const cmd of ALL_COMMANDS) {
    const start = performance.now();
    let reply = null;
    try {
      reply = await router.route(makeMsg(ctx, cmd), mockServices(ctx, stress));
    } catch {
      // comandos que fallan se cuentan igual
    }
    const elapsed = performance.now() - start;
    times.push(elapsed);
    perCmd.set(cmd, elapsed);
    perSize.set(cmd, replySize(reply));
    const after = process.memoryUsage().rss;
    peak = Math.max(peak, after);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }

  const cpu = process.cpuUsage(cpuBase);
  const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1);

  const blocks = GROUPS.map((group) => {
    const groupTimes = group.commands.map((cmd) => perCmd.get(cmd));
    const groupAvg = (groupTimes.reduce((a, b) => a + b, 0) / groupTimes.length).toFixed(1);
    const lines = group.commands
      .map((cmd) => `${cmd.padEnd(30)} ${perCmd.get(cmd).toFixed(1).padStart(7)} ms  ${kb(perSize.get(cmd)).padStart(7)} KB${sizeTag(perSize.get(cmd))}`)
      .join("\n");
    return [
      `*${group.label}* (${group.commands.length}) avg ${groupAvg} ms`,
      "```" + lines + "```",
    ].join("\n");
  });

  const over = [...perSize.entries()].filter(([, size]) => size > WA_LIMIT);
  const heavy = [...perCmd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const header = stress
    ? `*\u{1F52C} Stress ${TOTAL} comandos | ${STRESS_MEMBERS} miembros*`
    : `*\u{1F52C} Benchmark ${TOTAL} comandos*`;

  return [
    header,
    "",
    `RAM inicial:   ${mb(rssBefore)} MB`,
    `RAM pico:      ${mb(peak)} MB (+${mb(peak - rssBefore)} MB)`,
    `Heap pico:     ${mb(peakHeap)} MB`,
    `CPU total:     ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms`,
    `Tiempo/cmd:    min ${Math.min(...times).toFixed(1)} ms | max ${Math.max(...times).toFixed(1)} ms | avg ${avg} ms`,
    `Limite msg WA: ${kb(WA_LIMIT)} KB`,
    "",
    ...blocks,
    "",
    `*\u{1F534} TOP 5 mas lentos*`,
    heavy.map(([cmd, ms]) => `• ${cmd} ${ms.toFixed(1)} ms (${kb(perSize.get(cmd))} KB)`).join("\n"),
    "",
    over.length
      ? `*\u26A0\uFE0F SOBRE LIMITE (${over.length}):*\n` + over.map(([cmd, size]) => `• ${cmd} → ${kb(size)} KB`).join("\n")
      : `✅ Ninguna respuesta supera el limite de WhatsApp (${kb(WA_LIMIT)} KB)`,
  ].join("\n");
}

export const benchPlugin = {
  name: "bench",
  version: "1.0.0",
  register(api, options = {}) {
    const router = options.router;

    api.register(async (ctx) => {
      if (!ctx.isCommand || ctx.command !== "bench") return null;
      if (!router) return "Benchmark no disponible en este entorno.";

      const stress = ctx.args?.[0]?.toLowerCase() === "stress";
      return runBench(ctx, router, stress);
    }, { category: "HERRAMIENTAS", commands: ["bench"] });
  },
};
