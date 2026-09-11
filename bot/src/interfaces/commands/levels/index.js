import { LevelsStore } from "../../../infrastructure/storage/levelsStore.js";
import { cleanJid, jidUser, sameParticipant, participantIds } from "../../../shared/utils/jid.js";


const DEFAULT_CONFIG = {
  auraMin: 8,
  auraMax: 18,
  auraCooldownMs: 45 * 1000,
  topSize: 10,
};

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function auraForLevel(level) {
  return 100 + (level - 1) * 75;
}

function parseTarget(ctx) {
  const info = ctx.raw.message?.extendedTextMessage?.contextInfo;
  const fromMention = info?.mentionedJid?.[0];
  const fromQuote = info?.participant;
  const arg = ctx.args?.[0];
  return fromMention || fromQuote || (arg?.includes("@") ? arg : null);
}

function participantName(participant) {
  return participant?.name || participant?.notify || participant?.verifiedName || participant?.pushName || "";
}

function displayUser(user, metadata) {
  const jid = typeof user === "string" ? user : user.jid;
  if (typeof user === "object" && user.name) return user.name;

  const participant = metadata?.participants?.find((item) =>
    participantIds(item).some((id) => sameParticipant(id, jid)),
  );
  const name = participantName(participant);
  if (name) return name;

  const handle = jidUser(jid);
  return handle ? `@${handle}` : jid;
}

function applyMessageAura(config, store, ctx) {
  store.updateProfile(ctx.phone, ctx.sender, { name: ctx.name });
  const user = store.user(ctx.phone, ctx.sender);
  const now = Date.now();

  user.messages += 1;

  if (now - (user.lastAuraAt || 0) < config.auraCooldownMs) {
    store.save();
    return null;
  }

  const gained = randomInt(config.auraMin, config.auraMax);
  user.aura = (user.aura || 0) + gained;
  user.lastAuraAt = now;

  let leveled = false;
  while ((user.aura || 0) >= auraForLevel(user.level)) {
    user.aura -= auraForLevel(user.level);
    user.level += 1;
    leveled = true;
  }

  if (leveled) {
    store.log({ type: "level-up", jid: ctx.sender, level: user.level, group: ctx.phone });
  }

  store.save();
  return leveled ? `🎉 ¡${ctx.name} subió al nivel ${user.level}!` : null;
}

function makeHandler(config, store) {
  return async (ctx) => {
    await store.ready();
    if (!ctx.isCommand) {
      return applyMessageAura(config, store, ctx);
    }

    const command = ctx.command;

    if (command === "level" || command === "aura") {
      const target = parseTarget(ctx) || ctx.sender;
      const user = store.user(ctx.phone, target);
      const needed = auraForLevel(user.level);
      const metadata = ctx.isGroup ? await ctx.getGroupMetadata().catch(() => null) : null;
      const name = displayUser({ jid: target, ...user }, metadata);
      const text = `📊 *${name}*\nNivel: ${user.level} | Aura: ${user.aura || 0}/${needed} | Mensajes: ${user.messages}`;
      if (ctx.isGroup) {
        await ctx.sendMessage({ text, mentions: [target] });
        return null;
      }
      return text;
    }

    if (command === "rank" || command === "ranking" || command === "top") {
      const ranked = store.rankedUsers(ctx.phone).slice(0, config.topSize);
      if (!ranked.length) return "Todavía no hay suficientes datos para el ranking. ¡Hablen más! 📊";
      const metadata = ctx.isGroup ? await ctx.getGroupMetadata().catch(() => null) : null;
      const mentions = ranked.map((user) => user.jid);
      const text = [
        "🏆 *Ranking de este grupo*",
        ...ranked.map((user, index) => `${index + 1}. ${displayUser(user, metadata)} — Nivel ${user.level}, Aura ${user.aura || 0}, Mensajes ${user.messages}`),
      ].join("\n");

      if (ctx.isGroup) {
        await ctx.sendMessage({ text, mentions });
        return null;
      }
      return text;
    }

    return null;
  };
}

export const levelsPlugin = {
  name: "levels",
  version: "1.0.0",
  register(router, options = {}) {
    const config = { ...DEFAULT_CONFIG, ...options };
    const store = new LevelsStore();

    router.register(makeHandler(config, store), {
      category: "NIVELES",
      commands: ["level", "aura", "rank", "ranking", "top"],
    });
  },
};
