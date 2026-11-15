import { GroupAdminStore } from "../../../infrastructure/storage/groupAdminStore.js";
import { AntiNsfwStore } from "../../../infrastructure/storage/antiNsfwStore.js";
import { MSG } from "../../../shared/messages.js";
import { cleanJid, jidFromNumber, jidUser, participantIds, isAdminParticipant, findParticipant, resolvePhoneJid } from "../../../shared/utils/jid.js";
import { renderWelcomeTemplate, WELCOME_VARS_HELP } from "../../../shared/utils/welcomeTemplate.js";
import { getGroupSettingsStore } from "../../../infrastructure/storage/groupSettingsStore.js";
import { GROUP_MODULES, resolveModule } from "../../../shared/config/modules.js";
import { HALT } from "../../bot/router.js";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "assets");
const KIRK_IMAGE = ["kirkeado.jpg", "kirkeado.jpeg", "kirkeado.jfif", "kirkeado.png", "kirkeado.webp"]
  .map((file) => join(ASSETS_DIR, file))
  .find((path) => existsSync(path));
console.log("[kirk] imagen:", KIRK_IMAGE || "NO ENCONTRADA en assets");


const DEFAULT_CONFIG = {
  tagChunkSize: 40,
  linkPattern: /(https?:\/\/|chat\.whatsapp\.com\/|wa\.me\/)/i,
};

const BOT_ADMIN_COMMANDS = new Set(["close", "kick", "kirk", "kirkrandom", "add", "promote", "demote", "link", "resetlink"]);

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

  // El creador manda siempre. Sin esto, justo después de `autoPromote` la
  // metadata puede traer su entrada con `admin: null` y sus propios comandos
  // se rechazan como SOLO_ADMIN.
  const isCreator = senderIds.some((id) => ownerPolicy.isCreatorJid(id, metadata));

  if (!isAdminParticipant(sender) && !isCreator) {
    console.warn("[group_admin] SOLO_ADMIN: senderIds=", JSON.stringify(senderIds), "-> found:", sender?.id || "(none)", "| sample participants:", JSON.stringify((metadata?.participants || []).slice(0, 3)));
    return { ok: false, reason: MSG.SOLO_ADMIN };
  }

  const botIsAdmin = await ownerPolicy.isBotAdmin(ctx.getGroupMetadata, ctx.botJid, ctx.botLid);

  return { ok: true, metadata, sender, botIsAdmin, isCreator };
}

function needsBotAdmin(command) {
  return BOT_ADMIN_COMMANDS.has(command);
}

function commandText(ctx, skip = 0) {
  // `ctx.commandBody` conserva espacios y saltos de línea originales; `args`
  // los normaliza y rompe los mensajes de bienvenida/despedida con formato.
  if (skip === 0 && typeof ctx.commandBody === "string") return ctx.commandBody.trim();
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

async function anunciarYExpulsar(ctx, resolvedTarget, displayJid, { image = false } = {}) {
  const user = jidUser(displayJid);
  // `kick` es el comando normal: solo texto. La imagen quedó reservada para
  // `kirk` (easter egg por escribir mal el comando) y `kirkrandom`.
  const caption = image ? `🚨 @${user} te han kirkeado.` : `🚨 @${user} fue expulsado del grupo.`;
  const payload = image && KIRK_IMAGE
    ? { image: { url: KIRK_IMAGE }, caption, mentions: [displayJid] }
    : { text: caption, mentions: [displayJid] };
  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      await ctx.sendMessage(payload);
      break;
    } catch (err) {
      console.warn(`[expulsion] aviso intento ${intento}/3 falló:`, err?.message || err);
      await new Promise((r) => setTimeout(r, 5000 * intento));
    }
  }
  await ctx.updateParticipants([resolvedTarget], "remove");
  return null;
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

// ---- Menú de módulos interactivo ----
// Se guarda el id del mensaje del menú para aceptar solo respuestas que lo
// citen (así un "2" suelto en el chat no cambia nada).
const MODULE_MENU_TTL_MS = 10 * 60 * 1000;
const moduleMenus = new Map();

// Ajustes de grupo que no son plugins pero también se tocan desde el menú.
const MENU_SETTINGS = [
  { setting: "welcome", label: "Bienvenidas y despedidas", on: "activadas", off: "desactivadas" },
];

function menuEntries() {
  return [
    ...GROUP_MODULES.map((module) => ({ kind: "module", plugin: module.plugin, label: module.label })),
    ...MENU_SETTINGS.map((entry) => ({ kind: "setting", setting: entry.setting, label: entry.label, ...entry })),
  ];
}

function entryEnabled(entry, config, group) {
  if (entry.kind === "setting") return Boolean(group[entry.setting]);
  return !config.disabledModules.includes(entry.plugin);
}

function renderModuleMenu(ctx, config, group) {
  const lines = menuEntries().map((entry, index) => {
    const mark = entryEnabled(entry, config, group) ? "✅" : "❌";
    return `${index + 1}. ${mark} ${entry.label}`;
  });

  return [
    "⚙️ *Módulos de este grupo*",
    "",
    ...lines,
    "",
    `👉 *Responde a este mensaje* con los números que quieras cambiar. Ej: \`2\` o \`2 5\`.`,
    `También sirve \`${ctx.prefix}modulo 2\`.`,
  ].join("\n");
}

function parseMenuNumbers(text) {
  const entries = menuEntries();
  const matches = String(text || "").match(/\d{1,2}/g) || [];
  const numbers = [...new Set(matches.map(Number))].filter((n) => n >= 1 && n <= entries.length);
  return numbers.map((n) => entries[n - 1]).filter(Boolean);
}

function toggleEntries(entries, config, group) {
  const disabled = new Set(config.disabledModules);
  return entries.map((entry) => {
    if (entry.kind === "setting") {
      group[entry.setting] = !group[entry.setting];
      return `${group[entry.setting] ? "✅" : "❌"} *${entry.label}* ${group[entry.setting] ? entry.on : entry.off}`;
    }
    if (disabled.has(entry.plugin)) {
      disabled.delete(entry.plugin);
      config.disabledModules = [...disabled];
      return `✅ *${entry.label}* activado`;
    }
    disabled.add(entry.plugin);
    config.disabledModules = [...disabled];
    return `❌ *${entry.label}* desactivado`;
  });
}

async function sendModuleMenu(ctx, config, group) {
  const sent = await ctx.sendMessage({ text: renderModuleMenu(ctx, config, group) });
  moduleMenus.set(ctx.phone, { at: Date.now(), messageId: sent?.key?.id });
  return sent;
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

    if (!ctx.isCommand) {
      // Respuesta numérica al menú de módulos (solo si cita el mensaje del menú).
      const pending = moduleMenus.get(ctx.phone);
      if (pending && Date.now() - pending.at <= MODULE_MENU_TTL_MS && pending.messageId) {
        const info = ctx.raw?.message?.extendedTextMessage?.contextInfo;
        if (info?.stanzaId === pending.messageId) {
          const entries = parseMenuNumbers(ctx.text);
          if (!entries.length) {
            return "Responde con los números del menú (ej: `2` o `2 5`).";
          }
          const auth = await getAuth(ctx, ownerPolicy);
          if (!auth.ok) return auth.reason;
          const settings = getGroupSettingsStore();
          await settings.ready();
          const groupConfig = settings.group(ctx.phone);
          const changes = toggleEntries(entries, groupConfig, group);
          await settings.save();
          await store.save();
          const sent = await ctx.sendMessage({
            text: `${changes.join("\n")}\n\n${renderModuleMenu(ctx, groupConfig, group)}`,
          });
          moduleMenus.set(ctx.phone, { at: Date.now(), messageId: sent?.key?.id });
          return HALT;
        }
      }
      return null;
    }

    const adminCommands = new Set([
      "close", "tagall", "hidetag", "kick", "kirk", "kirkrandom", "add", "promote", "demote", "link", "resetlink",
      "mutechat", "unmutechat", "antilink", "welcome", "setwelcome", "setbye", "warn", "warnings", "clearwarns",
      "bot", "modulo", "modulos",
    ]);
    if (!adminCommands.has(ctx.command)) return null;

    const auth = await getAuth(ctx, ownerPolicy);
    if (!auth.ok) return auth.reason;

    if (ctx.command === "kick" || ctx.command === "kirk") {
      // Usa el chequeo central (detecta al bot por teléfono y por LID).
      const { clean: targetClean } = targetJid(ctx);
      if (targetClean && ownerPolicy.isProtectedJid(targetClean, ctx, auth.metadata)) return MSG.USUARIO_PROTEGIDO;
      if (!auth.botIsAdmin) return MSG.BOT_NECESITA_ADMIN;
    } else if (ctx.command === "kirkrandom") {
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

      if (ctx.command === "kick" || ctx.command === "kirk" || ctx.command === "promote" || ctx.command === "demote") {
        const { raw: targetRaw, clean: targetClean } = targetJid(ctx);
        if (!targetClean) return MSG.INDICA_USUARIO;
        if (
          (ctx.command === "kick" || ctx.command === "kirk" || ctx.command === "demote") &&
          ownerPolicy.isProtectedJid(targetClean, ctx, auth.metadata)
        ) {
          return MSG.USUARIO_PROTEGIDO;
        }
        const isRemoval = ctx.command === "kick" || ctx.command === "kirk";
        const action = isRemoval ? "remove" : ctx.command;
        const resolvedTarget = resolveTargetJid(targetRaw, auth.metadata);
        const displayJid = resolvePhoneJid(resolvedTarget || targetClean, auth.metadata);
        if (action === "remove") {
          return anunciarYExpulsar(ctx, resolvedTarget, displayJid, { image: ctx.command === "kirk" });
        }
        await ctx.updateParticipants([resolvedTarget], action);
        const actionLabel = action === "promote" ? "promovido a admin 🌟" : "removido como admin";
        return { text: `✅ @${jidUser(displayJid)} fue ${actionLabel}.`, mentions: [displayJid] };
      }

      if (ctx.command === "kirkrandom") {
        // Ruleta: le puede tocar a cualquiera, incluso admins.
        // Solo respeta protegidos (creador, bot y lista !protected).
        const candidatos = (auth.metadata.participants || []).filter(
          (p) => !ownerPolicy.isProtectedJid(p.id, ctx, auth.metadata),
        );
        if (!candidatos.length) return "No hay a quién kirkear: todos son admins o están protegidos 😅";
        const victima = candidatos[Math.floor(Math.random() * candidatos.length)];
        const displayJid = resolvePhoneJid(victima.id, auth.metadata);
        return anunciarYExpulsar(ctx, victima.id, displayJid, { image: true });
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
    if (ctx.command === "bot") {
      const action = String(ctx.args?.[0] || "").toLowerCase();
      const settings = getGroupSettingsStore();
      await settings.ready();
      const config = settings.group(ctx.phone);
      if (action !== "on" && action !== "off") {
        return [
          `Uso: ${ctx.prefix}bot on|off`,
          `Estado actual: ${config.botEnabled ? "encendido ✅" : "apagado 🔇"}`,
        ].join("\n");
      }
      config.botEnabled = action === "on";
      await settings.save();
      return config.botEnabled
        ? "✅ Bot encendido en este grupo."
        : "🔇 Bot apagado en este grupo. No responderá a nada (solo un admin puede reactivarlo con !bot on).";
    }

    if (ctx.command === "modulos") {
      const settings = getGroupSettingsStore();
      await settings.ready();
      await sendModuleMenu(ctx, settings.group(ctx.phone), group);
      return HALT;
    }

    if (ctx.command === "modulo") {
      const args = ctx.args || [];
      const action = String(args[0] || "").toLowerCase();
      const settings = getGroupSettingsStore();
      await settings.ready();
      const groupConfig = settings.group(ctx.phone);

      // `!modulo 3` alterna el elemento número 3 del menú (!modulos).
      const index = parseInt(args[0], 10);
      const entries = menuEntries();
      if (!args[1] && Number.isInteger(index) && index >= 1 && index <= entries.length) {
        const changes = toggleEntries([entries[index - 1]], groupConfig, group);
        await settings.save();
        await store.save();
        return `${changes[0]}\n\n${renderModuleMenu(ctx, groupConfig, group)}`;
      }

      const target = resolveModule(args.slice(1).join(" "));
      if ((action !== "on" && action !== "off") || !target) {
        return `Uso: ${ctx.prefix}modulo on|off <modulo>  ·  ${ctx.prefix}modulo <numero>\nMira el menú con ${ctx.prefix}modulos`;
      }
      const disabled = new Set(groupConfig.disabledModules);
      if (action === "off") disabled.add(target.plugin);
      else disabled.delete(target.plugin);
      groupConfig.disabledModules = [...disabled];
      await settings.save();
      return action === "off"
        ? `❌ Módulo *${target.label}* desactivado en este grupo.`
        : `✅ Módulo *${target.label}* activado en este grupo.`;
    }

    if (ctx.command === "welcome") {
      group.welcome = ctx.args?.[0] === "on";
      store.save();
      return `👋 Bienvenidas ${group.welcome ? "activadas ✅" : "desactivadas ❌"}.`;
    }
    if (ctx.command === "setwelcome") {
      const text = commandText(ctx);
      if (!text) return `Uso: ${ctx.prefix}setwelcome <texto>\n${WELCOME_VARS_HELP}`;
      group.welcomeText = text;
      store.save();
      return "✅ Mensaje de bienvenida actualizado.";
    }
    if (ctx.command === "setbye") {
      const text = commandText(ctx);
      if (!text) return `Uso: ${ctx.prefix}setbye <texto>\n${WELCOME_VARS_HELP}`;
      group.byeText = text;
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
  // Si el bot está apagado en el grupo tampoco manda bienvenidas/despedidas.
  const settings = getGroupSettingsStore();
  await settings.ready();
  if (settings.group(cleanJid(update.id)).botEnabled === false) return;
  const group = store.group(cleanJid(update.id));
  if (!group.welcome) return;

  // promote/demote también disparan este evento: solo saludamos al entrar/salir.
  const action = update.action;
  if (action !== "add" && action !== "remove") return;

  // El flujo de ingreso saluda con retraso (para que el mensaje sí se vea);
  // en ese caso este saludo se omite para no duplicarlo.
  if (action === "add" && typeof options.skipWelcome === "function") {
    try {
      if (await options.skipWelcome(update)) return;
    } catch {
      // Si la comprobación falla, se saluda igual: mejor duplicar que callar.
    }
  }

  let metadata = null;
  try {
    metadata = await services.getGroupMetadata?.(update.id);
  } catch {
    metadata = null;
  }
  const groupName = metadata?.subject || "el grupo";
  const count = metadata?.participants?.length;

  for (const participant of update.participants || []) {
    const template = action === "remove" ? group.byeText : group.welcomeText;
    const text = renderWelcomeTemplate(template, {
      user: `@${participant.split("@")[0]}`,
      group: groupName,
      count,
    });
    await services.sendMessage?.(update.id, { text, mentions: [participant] });
  }
}

/**
 * Plantilla de bienvenida configurada en el grupo ("" si no tiene).
 * La usa el flujo de ingreso para saludar con el mismo texto del grupo.
 */
export async function groupWelcomeTemplate(jid) {
  const { store } = getStore();
  await store.ready();
  const group = store.group(cleanJid(jid));
  return group.welcome ? group.welcomeText || "" : "";
}

export const groupAdminPlugin = {
  name: "group_admin",
  version: "1.0.0",
  register(router, options = {}) {
    getStore(options);
    router.register(makeHandler(options), {
      category: "ADMINISTRACION",
      commands: [
        // `kirk` no aparece aquí a propósito: es un easter egg por escribir mal
        // `kick`. Sigue funcionando y manda la foto, pero no se anuncia.
        "close", "tagall", "hidetag", "kick", "kirkrandom", "add", "promote", "demote", "link", "resetlink",
        "mutechat", "unmutechat", "antilink", "welcome", "setwelcome", "setbye", "warn", "warnings", "clearwarns",
        "bot", "modulo", "modulos",
      ],
    });
  },
};
