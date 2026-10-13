import { GroupAdminStore } from "../../../infrastructure/storage/groupAdminStore.js";
import { AntiNsfwStore } from "../../../infrastructure/storage/antiNsfwStore.js";
import { MSG } from "../../../shared/messages.js";
import { cleanJid, jidFromNumber, jidUser, participantIds, isAdminParticipant, findParticipant, resolvePhoneJid } from "../../../shared/utils/jid.js";


const DEFAULT_CONFIG = {
  tagChunkSize: 40,
  linkPattern: /(https?:\/\/|chat\.whatsapp\.com\/|wa\.me\/)/i,
};

const BOT_ADMIN_COMMANDS = new Set(["close", "kirk", "add", "promote", "demote", "link", "resetlink"]);

let sharedStore = null;
let sharedConfig = null;

function getStore(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  if (!sharedStore) {
    sharedStore = new GroupAdminStore();
  }
  sharedConfig = config;
  return { store: sharedStore, config };
}

async function getAuth(ctx, ownerPolicy) {
  if (!ctx.isGroup) return { ok: false, reason: MSG.SOLO_GRUPOS };
  const metadata = await ctx.getGroupMetadata();
  const senderIds = [
    ctx.sender,
    ctx.raw.key?.participant,
    ctx.raw.key?.participantPn,
    ctx.raw.key?.participantLid,
    ctx.raw.participant,
    ctx.raw.participantPn,
    ctx.raw.participantLid,
  ].filter(Boolean);
  const sender = findParticipant(metadata, senderIds);

  if (!isAdminParticipant(sender)) {
    console.warn("[group_admin] SOLO_ADMIN: senderIds=", JSON.stringify(senderIds), "-> found:", sender?.id || "(none)", "| sample participants:", JSON.stringify((metadata?.participants || []).slice(0, 3)));
    return { ok: false, reason: MSG.SOLO_ADMIN };
  }

  const botIsAdmin = await ownerPolicy.isBotAdmin(ctx.getGroupMetadata, ctx.botJid, ctx.botLid);

  return { ok: true, metadata, sender, botIsAdmin };
}

function needsBotAdmin(command) {
  return BOT_ADMIN_COMMANDS.has(command);
}

function commandText(ctx, skip = 0) {
  return (ctx.args || []).slice(skip).join(" ").trim();
}

function targetJid(ctx, skip = 0) {
  const info = ctx.raw.message?.extendedTextMessage?.contextInfo;
  const fromMention = info?.mentionedJid?.[0];
  const fromQuote = info?.participant;
  const arg = (ctx.args || [])[skip];
  const raw = fromMention || fromQuote || (arg?.includes("@") ? arg : jidFromNumber(arg));
  return { raw, clean: cleanJid(raw) };
}

function resolveTargetJid(rawJid, metadata) {
  if (!rawJid || !metadata?.participants) return rawJid;
  const found = findParticipant(metadata, [rawJid]);
  return found?.id || rawJid;
}

async function mentionAll(ctx, metadata, visible) {
  const ids = metadata.participants.map((item) => item.id);
  const chunks = [];
  for (let i = 0; i < ids.length; i += sharedConfig.tagChunkSize) {
    chunks.push(ids.slice(i, i + sharedConfig.tagChunkSize));
  }

  for (const chunk of chunks) {
    await ctx.sendMessage({
      text: visible ? chunk.map((jid) => `@${jid.split("@")[0]}`).join(" ") : "Mensaje para todos.",
      mentions: chunk,
    });
  }

  return null;
}

let _nsfwWarnStore = null;
async function getNsfwWarnStore() {
  if (!_nsfwWarnStore) {
    _nsfwWarnStore = new AntiNsfwStore();
    await _nsfwWarnStore.ready();
  }
  return _nsfwWarnStore;
}

async function addWarning(store, ctx, jid) {
  const group = store.group(ctx.phone);
  group.warnings[jid] = (group.warnings[jid] || 0) + 1;
  store.save();
  (await getNsfwWarnStore()).addInfraction(ctx.phone, jid);
  return group.warnings[jid];
}

function makeHandler(options) {
  const { store, config } = getStore(options);
  const ownerPolicy = options.ownerPolicy;

  return async (ctx) => {
    await store.ready();
    const group = store.group(ctx.phone);

    if (ctx.isGroup && group.antilink && config.linkPattern.test(ctx.text) && ctx.sender !== ctx.botJid) {
      const metadata = await ctx.getGroupMetadata().catch(() => null);
      if (ownerPolicy.isProtectedJid(ctx.sender, ctx, metadata)) return null;

      await ctx.deleteMessage(ctx.raw.key);
      const warnings = await addWarning(store, ctx, ctx.sender);
      const linkPhone = resolvePhoneJid(ctx.sender, metadata);
      if (warnings >= 3) {
        await ctx.sendMessage({ text: `🫵 @${jidUser(linkPhone)} se lo gano oyo por acumular 3 advertencias ⚠️`, mentions: [linkPhone] }).catch(() => {});
        await ctx.updateParticipants([ctx.sender], "remove").catch(() => null);
        return null;
      }
      return { text: `🔗 Link detectado y eliminado. @${jidUser(linkPhone)}: advertencia ${warnings}/3 ⚠️`, mentions: [linkPhone] };
    }

    if (ctx.isGroup && group.muted && ctx.isCommand && !["unmutechat", "help"].includes(ctx.command)) {
      const auth = await getAuth(ctx, ownerPolicy);
      if (!auth.ok) return "🔇 El grupo está silenciado. Solo los admins pueden usar comandos.";
    }

    if (!ctx.isCommand) return null;

    const adminCommands = new Set([
      "close", "tagall", "hidetag", "kirk", "add", "promote", "demote", "link", "resetlink",
      "mutechat", "unmutechat", "antilink", "welcome", "setwelcome", "setbye", "warn", "warnings", "clearwarns",
    ]);
    if (!adminCommands.has(ctx.command)) return null;

    const auth = await getAuth(ctx, ownerPolicy);
    if (!auth.ok) return auth.reason;

    if (ctx.command === "kirk") {
      // DEBUG TEMPORAL: ver por qué no detecta admin al bot
      try {
        const dbgParts = (auth.metadata?.participants || []).map((p) => ({ id: p.id, lid: p.lid, jid: p.jid, admin: p.admin }));
        console.log("[kirk-debug] botJid=", ctx.botJid, "botLid=", ctx.botLid, "botIsAdmin=", auth.botIsAdmin, "parts=", JSON.stringify(dbgParts).slice(0, 1500));
      } catch {}
      // Usa el chequeo central (detecta al bot por teléfono y por LID).
      const { clean: targetClean } = targetJid(ctx);
      if (targetClean && ownerPolicy.isProtectedJid(targetClean, ctx, auth.metadata)) return MSG.USUARIO_PROTEGIDO;
      if (!auth.botIsAdmin) return MSG.BOT_NECESITA_ADMIN;
    } else if (ctx.command === "demote") {
      const { clean: targetClean } = targetJid(ctx);
      if (targetClean && ownerPolicy.isProtectedJid(targetClean, ctx, auth.metadata)) return MSG.USUARIO_PROTEGIDO;
      if (!auth.botIsAdmin) return MSG.BOT_NECESITA_ADMIN;
    } else if (needsBotAdmin(ctx.command) && !auth.botIsAdmin) {
      return MSG.BOT_NECESITA_ADMIN;
    }

    try {
      if (ctx.command === "close") {
        await ctx.updateGroupSetting("announcement");
        return "✅ Grupo cerrado. Solo los admins pueden escribir.";
      }
      if (ctx.command === "tagall") return mentionAll(ctx, auth.metadata, true);
      if (ctx.command === "hidetag") return mentionAll(ctx, auth.metadata, false);

      if (ctx.command === "kirk" || ctx.command === "promote" || ctx.command === "demote") {
        const { raw: targetRaw, clean: targetClean } = targetJid(ctx);
        if (!targetClean) return MSG.INDICA_USUARIO;
        if ((ctx.command === "kirk" || ctx.command === "demote") && ownerPolicy.isProtectedJid(targetClean, ctx, auth.metadata)) {
          return MSG.USUARIO_PROTEGIDO;
        }
        const action = ctx.command === "kirk" ? "remove" : ctx.command;
        const resolvedTarget = resolveTargetJid(targetRaw, auth.metadata);
        const displayJid = resolvePhoneJid(resolvedTarget || targetClean, auth.metadata);
        if (action === "remove") {
          await ctx.sendMessage({ text: `🚨 @${jidUser(displayJid)} te han kirkeado.`, mentions: [displayJid] }).catch(() => {});
          await ctx.updateParticipants([resolvedTarget], action);
          return null;
        }
        await ctx.updateParticipants([resolvedTarget], action);
        const actionLabel = action === "promote" ? "promovido a admin 🌟" : "removido como admin";
        return { text: `✅ @${jidUser(displayJid)} fue ${actionLabel}.`, mentions: [displayJid] };
      }

      if (ctx.command === "add") {
        const target = jidFromNumber(ctx.args?.[0]);
        if (!target) return "Indica un número de teléfono válido 📞";
        await ctx.updateParticipants([target], "add");
        return "✅ Invitación enviada.";
      }

      if (ctx.command === "link") {
        const code = await ctx.inviteCode();
        return `🔗 https://chat.whatsapp.com/${code}`;
      }
      if (ctx.command === "resetlink") {
        await ctx.revokeInvite();
        const code = await ctx.inviteCode();
        return `🔗 Nuevo link del grupo: https://chat.whatsapp.com/${code}`;
      }
    } catch (err) {
      console.warn("[group_admin] Accion rechazada por WhatsApp:", err?.message || err);
      return "No pude ejecutar esa acción. Verifica que tenga los permisos necesarios ⚠️";
    }

    if (ctx.command === "mutechat") {
      group.muted = true;
      store.save();
      return "🔇 Comandos silenciados. Solo los admins pueden usarlos.";
    }
    if (ctx.command === "unmutechat") {
      group.muted = false;
      store.save();
      return "🔊 Comandos reactivados. Todos pueden usarlos.";
    }
    if (ctx.command === "antilink") {
      group.antilink = ctx.args?.[0] === "on";
      store.save();
      return `🔗 Antilink ${group.antilink ? "activado ✅" : "desactivado ❌"}.`;
    }
    if (ctx.command === "welcome") {
      group.welcome = ctx.args?.[0] === "on";
      store.save();
      return `👋 Bienvenidas ${group.welcome ? "activadas ✅" : "desactivadas ❌"}.`;
    }
    if (ctx.command === "setwelcome") {
      group.welcomeText = commandText(ctx) || group.welcomeText;
      store.save();
      return "✅ Mensaje de bienvenida actualizado.";
    }
    if (ctx.command === "setbye") {
      group.byeText = commandText(ctx) || group.byeText;
      store.save();
      return "✅ Mensaje de despedida actualizado.";
    }
    if (ctx.command === "warn") {
      let count = 1;
      let skip = 0;
      const first = parseInt(ctx.args?.[0], 10);
      if (!isNaN(first) && first > 0) {
        count = Math.min(first, 50);
        skip = 1;
      }
      const { clean: targetClean } = targetJid(ctx, skip);
      if (!targetClean) return MSG.INDICA_USUARIO;
      const metadata = await ctx.getGroupMetadata().catch(() => null);
      if (ownerPolicy.isProtectedJid(targetClean, ctx, metadata)) return MSG.USUARIO_PROTEGIDO;
      let finalCount = 0;
      for (let i = 0; i < count; i++) {
        finalCount = await addWarning(store, ctx, targetClean);
      }
      const warnPhone = resolvePhoneJid(targetClean, auth.metadata);
      if (finalCount >= 3) {
        if (!auth.botIsAdmin) return MSG.BOT_NECESITA_ADMIN;
        await ctx.sendMessage({ text: `🫵 @${jidUser(warnPhone)} expulsado por acumular 3 advertencias ⚠️`, mentions: [warnPhone] });
        await ctx.updateParticipants([targetClean], "remove");
        return null;
      }
      return { text: `⚠️ @${jidUser(warnPhone)} tiene ${finalCount} advertencia(s) acumuladas.`, mentions: [warnPhone] };
    }
    if (ctx.command === "warnings") {
      const { clean: targetClean } = targetJid(ctx) || {};
      const target = targetClean || ctx.sender;
      const warningsPhone = resolvePhoneJid(target, auth.metadata);
      return { text: `📋 @${jidUser(warningsPhone)}: ${group.warnings[target] || 0} advertencia(s).`, mentions: [warningsPhone] };
    }
    if (ctx.command === "clearwarns") {
      const { clean: targetClean } = targetJid(ctx);
      if (!targetClean) return MSG.INDICA_USUARIO;
      delete group.warnings[targetClean];
      store.save();
      const clearPhone = resolvePhoneJid(targetClean, auth.metadata);
      return { text: `✅ Advertencias de @${jidUser(clearPhone)} borradas.`, mentions: [clearPhone] };
    }

    return null;
  };
}

export async function handleGroupParticipantsUpdate(update, services = {}, options = {}) {
  const { store } = getStore(options);
  await store.ready();
  const group = store.group(cleanJid(update.id));
  if (!group.welcome) return;

  for (const participant of update.participants || []) {
    const template = update.action === "remove" ? group.byeText : group.welcomeText;
    const text = template.replaceAll("{user}", `@${participant.split("@")[0]}`);
    await services.sendMessage?.(update.id, { text, mentions: [participant] });
  }
}

export const groupAdminPlugin = {
  name: "group_admin",
  version: "1.0.0",
  register(router, options = {}) {
    getStore(options);
    router.register(makeHandler(options), {
      category: "ADMINISTRACION",
      commands: [
        "close", "tagall", "hidetag", "kirk", "add", "promote", "demote", "link", "resetlink",
        "mutechat", "unmutechat", "antilink", "welcome", "setwelcome", "setbye", "warn", "warnings", "clearwarns",
      ],
    });
  },
};
