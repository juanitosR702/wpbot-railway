import { MSG } from "../../../shared/messages.js";
import { findParticipant, isAdminParticipant } from "../../../shared/utils/jid.js";
import { inviteUrl, LOBBY_DEFAULTS } from "../../../shared/utils/lobbyFlow.js";

// Configuración del flujo lobby -> general. La automatización vive en
// `shared/utils/lobbyFlow.js` y se dispara desde `app/bootstrap.js`; acá solo se
// guarda qué grupo es cada uno y se muestra el estado.
export const lobbyPlugin = {
  name: "lobby",
  version: "1.0.0",

  register(api, options = {}) {
    // Carga diferida: el store importa Mongo, así el plugin se puede testear
    // inyectando `options.store`.
    let storePromise = null;
    async function getStore() {
      if (options.store) return options.store;
      if (!storePromise) {
        storePromise = import("../../../infrastructure/storage/lobbyStore.js")
          .then(({ getLobbyStore }) => getLobbyStore());
      }
      return storePromise;
    }

    api.register(async (ctx) => {
      if (!ctx.isCommand || ctx.command !== "lobby") return null;
      if (!ctx.isGroup) return MSG.SOLO_GRUPOS;
      const store = await getStore();
      if (typeof store.ready === "function") await store.ready().catch(() => {});
      return handle(ctx, store, options);
    }, {
      commands: ["lobby"],
      category: "LOBBY",
    });
  },
};

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

async function handle(ctx, store, options) {
  const auth = await getAdmin(ctx, options.ownerPolicy);
  if (!auth.ok) return auth.reason;

  const sub = normalize(ctx.args[0] || "ver");
  const arg = normalize(ctx.args[1] || "");
  const here = `${ctx.phone}@g.us`;

  if (sub === "on" || sub === "off") {
    store.setEnabled(sub === "on");
    await store.save();
    return sub === "on"
      ? "✅ Lobby automático activado."
      : "❌ Lobby automático desactivado (no acepta, no saluda ni expulsa).";
  }

  if (sub === "aqui" || sub === "acá") {
    if (arg !== "lobby" && arg !== "general") {
      return [
        "Uso:",
        `• *${ctx.prefix}lobby aqui lobby* → este grupo es el lobby`,
        `• *${ctx.prefix}lobby aqui general* → este grupo es el general`,
      ].join("\n");
    }

    const config = store.config();
    if (arg === "lobby") {
      if (config.generalJid === here) return "⚠️ Este grupo ya está configurado como *general*.";
      store.setLobby(here);
    } else {
      if (config.lobbyJid === here) return "⚠️ Este grupo ya está configurado como *lobby*.";
      store.setGeneral(here);
      const code = await inviteCodeFor(ctx, here);
      if (code) store.setGeneralCode(code);
    }
    await store.save();

    const link = arg === "general" ? inviteUrl(store.config().generalCode) : "";
    const botAdmin = await isBotAdminIn(ctx, here, options.ownerPolicy);
    return [
      arg === "lobby"
        ? "✅ Este grupo queda como *lobby*."
        : `✅ Este grupo queda como *general*.${link ? `\n🔗 Link: ${link}` : ""}`,
      "",
      botAdmin ? "✅ Soy admin aquí." : "⚠️ No soy admin aquí: necesito serlo para aceptar y expulsar.",
    ].join("\n");
  }

  if (sub === "demora" || sub === "delay" || sub === "espera") {
    const seconds = Number(arg.replace(",", "."));
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) {
      return "Uso: *!lobby demora <segundos>* (0 a 120).";
    }
    store.setWelcomeDelay(Math.round(seconds * 1000));
    await store.save();
    return `⏱️ El saludo esperará *${Math.round(seconds)} s* después de que la persona entre.`;
  }

  if (sub === "reset" || sub === "limpiar") {
    store.state.greeted = {};
    store.state.submitted = {};
    await store.save();
    return "♻️ Lista de saludados y fichas enviadas vaciada (los grupos se conservan).";
  }

  if (sub !== "ver" && sub !== "estado" && sub !== "status") {
    return [
      "*Lobby automático*",
      `• ${ctx.prefix}lobby ver`,
      `• ${ctx.prefix}lobby on | off`,
      `• ${ctx.prefix}lobby aqui lobby | aqui general`,
      `• ${ctx.prefix}lobby demora <segundos>`,
      `• ${ctx.prefix}lobby reset`,
    ].join("\n");
  }

  return status(ctx, store, options);
}

async function status(ctx, store, options) {
  const config = store.config();
  const link = inviteUrl(config.generalCode);
  const submitted = Object.keys(config.submitted || {}).length;
  const greeted = Object.keys(config.greeted || {}).length;

  const [lobbyAdmin, generalAdmin] = await Promise.all([
    config.lobbyJid ? isBotAdminIn(ctx, config.lobbyJid, options.ownerPolicy) : Promise.resolve(false),
    config.generalJid ? isBotAdminIn(ctx, config.generalJid, options.ownerPolicy) : Promise.resolve(false),
  ]);

  return [
    `🛎️ *Lobby automático* ${config.enabled ? "✅ activo" : "❌ apagado"}`,
    "",
    `• Lobby: ${config.lobbyJid || "sin configurar"}`,
    `• General: ${config.generalJid || "sin configurar"}`,
    `• Demora del saludo: ${Math.round(config.welcomeDelayMs / 100) / 10} s`,
    `• Saludados: ${greeted} · Fichas enviadas: ${submitted}`,
    `• Link del general: ${link || "se genera al mandarlo"}`,
    `• Soy admin: lobby ${lobbyAdmin ? "✅" : "❌"} · general ${generalAdmin ? "✅" : "❌"}`,
    "",
    `Configura con *${ctx.prefix}lobby aqui lobby* y *${ctx.prefix}lobby aqui general* en cada grupo.`,
    config.enabled && config.lobbyJid && config.generalJid
      ? ""
      : `⚠️ Falta configurar los dos grupos para que el flujo arranque (demora por defecto ${LOBBY_DEFAULTS.welcomeDelayMs / 1000} s).`,
  ].filter(Boolean).join("\n");
}

async function inviteCodeFor(ctx, jid) {
  try {
    return (await ctx.services?.inviteCode?.(jid)) || "";
  } catch (err) {
    console.warn("[lobby] no pude obtener el código de invitación:", err?.message || err);
    return "";
  }
}

async function isBotAdminIn(ctx, jid, ownerPolicy) {
  try {
    return await ownerPolicy?.isBotAdmin?.(
      () => ctx.services?.getGroupMetadata?.(jid),
      ctx.botJid,
      ctx.botLid,
    );
  } catch {
    return false;
  }
}

// El creador siempre manda; si no, hace falta ser admin del grupo.
async function getAdmin(ctx, ownerPolicy) {
  const metadata = await ctx.getGroupMetadata?.().catch(() => null);
  const senderIds = [
    ctx.sender,
    ctx.raw?.key?.participant,
    ctx.raw?.key?.participantPn,
    ctx.raw?.key?.participantLid,
  ].filter(Boolean);
  const sender = findParticipant(metadata, senderIds);
  const isCreator = senderIds.some((id) => ownerPolicy?.isCreatorJid?.(id, metadata));

  if (isAdminParticipant(sender) || isCreator) return { ok: true, metadata };
  return { ok: false, reason: MSG.SOLO_ADMIN };
}
