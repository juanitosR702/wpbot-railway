import { ModerationStore } from "../../../infrastructure/storage/moderationStore.js";
import { HALT } from "../../bot/router.js";
import { MSG } from "../../../shared/messages.js";
import { cleanJid, jidFromNumber, jidUser, sameParticipant, findParticipant, isAdminParticipant, resolvePhoneJid } from "../../../shared/utils/jid.js";


const DEFAULT_CONFIG = {
  spamWindowMs: 7000,
  spamMaxMessages: 5,
  spamWarnThreshold: 3,
  autoDeleteSpam: true,
};

const buckets = new Map();
const metadataCache = new Map();
const METADATA_TTL = 60000;

async function getMetadata(ctx) {
  if (!ctx.isGroup) return null;
  const cached = metadataCache.get(ctx.phone);
  if (cached && Date.now() - cached.ts < METADATA_TTL) return cached.data;
  const data = await ctx.getGroupMetadata().catch(() => null);
  if (data) metadataCache.set(ctx.phone, { data, ts: Date.now() });
  return data;
}

async function getGroupAuth(ctx, ownerPolicy) {
  if (!ctx.isGroup) return { ok: false, reason: MSG.SOLO_GRUPOS };
  const metadata = await getMetadata(ctx);
  const sender = findParticipant(metadata, [
    ctx.sender,
    ctx.raw.key?.participant,
    ctx.raw.participant,
    ctx.raw.participantPn,
    ctx.raw.participantLid,
  ]);
  return {
    ok: isAdminParticipant(sender),
    reason: MSG.SOLO_ADMIN,
    metadata,
    botIsAdmin: await ownerPolicy.isBotAdmin(ctx.getGroupMetadata, ctx.botJid, ctx.botLid),
  };
}

function senderIds(ctx) {
  return [
    ctx.sender,
    ctx.raw.key?.participant,
    ctx.raw.participant,
    ctx.raw.participantPn,
    ctx.raw.participantLid,
  ].filter(Boolean);
}

function mutedTarget(group, ctx) {
  return Object.keys(group.muted).find((target) =>
    senderIds(ctx).some((sender) => sameParticipant(target, sender)),
  );
}

function mentionedJid(ctx) {
  const quoted = ctx.raw.message?.extendedTextMessage?.contextInfo;
  const fromQuote = quoted?.participant;
  const fromMention = quoted?.mentionedJid?.[0];
  const fromArg = ctx.args?.[0];
  return cleanJid(fromQuote || fromMention || (fromArg?.includes("@") ? fromArg : jidFromNumber(fromArg)));
}

function quotedKey(ctx) {
  const info = ctx.raw.message?.extendedTextMessage?.contextInfo;
  if (!info?.stanzaId) return null;

  return {
    remoteJid: info.remoteJid || ctx.raw.key?.remoteJid,
    id: info.stanzaId,
    participant: info.participant,
  };
}

async function safeDelete(ctx, key) {
  if (!key) return false;
  try {
    await ctx.deleteMessage(key);
    return true;
  } catch (err) {
    console.warn("[moderation] Baileys no pudo eliminar mensaje:", err?.message || err);
    return false;
  }
}

function addWarning(store, ctx, target, reason, source = "manual") {
  const group = store.group(ctx.phone);
  const current = group.warnings[target] || { count: 0, reasons: [] };
  current.count += 1;
  current.reasons.push({ at: new Date().toISOString(), reason, source, by: ctx.sender });
  group.warnings[target] = current;
  store.log({ type: "warning", group: ctx.phone, target, by: ctx.sender, reason, source });
  return current.count;
}

function trackSpam(config, sender) {
  const now = Date.now();
  const bucket = buckets.get(sender) || [];
  const fresh = bucket.filter((stamp) => now - stamp <= config.spamWindowMs);
  fresh.push(now);
  buckets.set(sender, fresh);
  return fresh.length;
}

function makeHandler(config, store, ownerPolicy) {
  return async (ctx) => {
    await store.ready();
    const command = ctx.command;
    const group = store.group(ctx.phone);
    const metadata = await getMetadata(ctx);
    const senderProtected = ownerPolicy.isProtectedJid(ctx.sender, ctx, metadata);

    if (!senderProtected && group.blacklist[ctx.sender]) {
      store.log({ type: "blacklist-hit", group: ctx.phone, sender: ctx.sender, text: ctx.text });
      await safeDelete(ctx, ctx.raw.key);
      return HALT;
    }

    const muteTarget = mutedTarget(group, ctx);
    if (!senderProtected && muteTarget) {
      store.log({ type: "mute-hit", group: ctx.phone, sender: ctx.sender, target: muteTarget, text: ctx.text });
      await safeDelete(ctx, ctx.raw.key);
      return HALT;
    }

    if (!ctx.isCommand && !senderProtected) {
      const spamCount = trackSpam(config, `${ctx.phone}:${ctx.sender}`);
      if (spamCount > config.spamMaxMessages) {
        const warnings = addWarning(store, ctx, ctx.sender, "anti spam", "anti-spam");
        if (config.autoDeleteSpam) await safeDelete(ctx, ctx.raw.key);
        const spamPhone = resolvePhoneJid(ctx.sender, metadata);
        return { text: `⚠️ @${jidUser(spamPhone)} acumula ${warnings} advertencia(s) por spam.`, mentions: [spamPhone] };
      }
    }

    if (command === "del") {
      if (!ctx.isGroup) return MSG.SOLO_GRUPOS;
      const auth = await getGroupAuth(ctx, ownerPolicy);
      if (!auth.ok) return auth.reason;
      if (!auth.botIsAdmin) return MSG.BOT_NECESITA_ADMIN;
      const targetKey = quotedKey(ctx);
      if (!targetKey) return "Responde al mensaje que quieres eliminar.";
      const deletedTarget = await safeDelete(ctx, targetKey);
      await safeDelete(ctx, ctx.raw.key);
      store.log({ type: "delete", group: ctx.phone, by: ctx.sender, target: targetKey.id, ok: deletedTarget });
      return deletedTarget ? HALT : "No pude eliminar ese mensaje; puede que ya no exista.";
    }
    if (command === "delme") {
      const ok = await safeDelete(ctx, ctx.raw.key);
      store.log({ type: "delete-self", group: ctx.phone, by: ctx.sender, ok });
      return ok ? null : "No pude eliminar tu mensaje, inténtalo de nuevo ⚠️";
    }

    if (command === "blacklist") {
      if (!ownerPolicy.isCreatorJid(ctx.sender, metadata)) return "Solo el creador puede usar este comando 🔒";
      const target = mentionedJid(ctx);
      if (!target) return "Menciona o responde al usuario que quieres banear 🚫";
      if (ownerPolicy.isProtectedJid(target, ctx, metadata)) return MSG.USUARIO_PROTEGIDO;
      group.blacklist[target] = { by: ctx.sender, at: new Date().toISOString() };
      store.log({ type: "blacklist-add", group: ctx.phone, by: ctx.sender, target });
      const blPhone = resolvePhoneJid(target, metadata);
      return { text: `🚫 @${jidUser(blPhone)} baneado. Sus mensajes serán eliminados automáticamente.`, mentions: [blPhone] };
    }

    if (command === "unblacklist") {
      if (!ownerPolicy.isCreatorJid(ctx.sender, metadata)) return "Solo el creador puede usar este comando 🔒";
      const target = mentionedJid(ctx);
      if (!target) return "Menciona o responde al usuario que quieres desbanear ✅";
      delete group.blacklist[target];
      store.log({ type: "blacklist-remove", group: ctx.phone, by: ctx.sender, target });
      const unblPhone = resolvePhoneJid(target, metadata);
      return { text: `✅ @${jidUser(unblPhone)} eliminado de la lista negra.`, mentions: [unblPhone] };
    }

    if (command === "mute") {
      if (!ctx.isGroup) return MSG.SOLO_GRUPOS;
      const auth = await getGroupAuth(ctx, ownerPolicy);
      if (!auth.ok) return auth.reason;

      const target = mentionedJid(ctx);
      if (!target) return "Menciona o responde al usuario que quieres silenciar 🔇";
      if (ownerPolicy.isProtectedJid(target, ctx, auth.metadata || metadata)) return MSG.USUARIO_PROTEGIDO;
      if (!auth.botIsAdmin) return "Necesito ser admin para eliminar mensajes de usuarios silenciados 🤖";

      group.muted[target] = { by: ctx.sender, at: new Date().toISOString() };
      store.log({ type: "mute", group: ctx.phone, by: ctx.sender, target });
      const mutePhone = resolvePhoneJid(target, metadata);
      return { text: `🔇 @${jidUser(mutePhone)} silenciado. Sus mensajes serán eliminados automáticamente.`, mentions: [mutePhone] };
    }

    if (command === "unmute") {
      if (!ctx.isGroup) return MSG.SOLO_GRUPOS;
      const auth = await getGroupAuth(ctx, ownerPolicy);
      if (!auth.ok) return auth.reason;

      const target = mentionedJid(ctx);
      if (!target) return "Menciona o responde al usuario que quieres dessilenciar 🔊";
      delete group.muted[target];
      store.log({ type: "unmute", group: ctx.phone, by: ctx.sender, target });
      const unmutePhone = resolvePhoneJid(target, metadata);
      return { text: `🔊 @${jidUser(unmutePhone)} dessilenciado correctamente.`, mentions: [unmutePhone] };
    }

    if (command === "modlogs") {
      const recent = store.state.logs
        .filter((entry) => entry.group === ctx.phone)
        .slice(-5)
        .map((entry) => `- ${entry.at} ${entry.type} ${entry.target || entry.sender || ""}`.trim());
      return recent.length ? recent.join("\n") : "No hay registros de moderación para este grupo todavía 📋";
    }

    return null;
  };
}

export const moderationPlugin = {
  name: "moderation",
  version: "1.0.0",
  register(router, options = {}) {
    const config = { ...DEFAULT_CONFIG, ...options };
    const store = new ModerationStore();
    router.register(makeHandler(config, store, options.ownerPolicy), {
      category: "MODERACION",
      commands: ["del", "delme", "blacklist", "unblacklist", "mute", "unmute", "modlogs"],
    });
  },
};
