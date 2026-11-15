import { MSG } from "../../../shared/messages.js";
import { findParticipant, isAdminParticipant } from "../../../shared/utils/jid.js";
import { inviteUrl, LOBBY_DEFAULTS } from "../../../shared/utils/lobbyFlow.js";
import { renderFilters } from "../../../shared/utils/lobbyFilters.js";

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

function isOff(value) {
  return ["off", "quitar", "ninguno", "borrar", "no", "0", "-"].includes(normalize(value));
}

function parseAgeArg(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  const age = Number(digits);
  if (!digits || !Number.isInteger(age) || age < 1 || age > 99) return null;
  return age;
}

function splitList(text) {
  return String(text || "")
    .split(/[,;/]/)
    .map((item) => item.trim())
    .filter(Boolean);
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
    return "♻️ Lista de saludados y fichas enviadas vaciada (los grupos y los filtros se conservan).";
  }

  if (sub === "edad" || sub === "age") {
    if (isOff(arg)) {
      store.setMinAge(0);
      await store.save();
      return "🚫 Filtro de edad desactivado.";
    }
    const age = parseAgeArg(arg);
    if (!age) {
      return `⚠️ Indica la edad mínima (1–99). Ej: *${ctx.prefix}lobby edad 18* (o *${ctx.prefix}lobby edad off*).`;
    }
    store.setMinAge(age);
    await store.save();
    return `🚫 Solo pasan al general las personas de *${age} años o más*.`;
  }

  if (sub === "paises" || sub === "pais" || sub === "countries") {
    const value = ctx.args.slice(1).join(" ");
    if (isOff(value)) {
      store.setCountries([]);
      await store.save();
      return "🚫 Filtro de país desactivado.";
    }
    const list = splitList(value);
    if (!list.length) {
      return `⚠️ Indica los países separados por coma. Ej: *${ctx.prefix}lobby paises Colombia, México*`;
    }
    store.setCountries(list);
    await store.save();
    return `🚫 Solo pasan al general los países: *${list.join(", ")}*.`;
  }

  if (sub === "iniciales" || sub === "inicial") {
    const value = ctx.args.slice(1).join(" ");
    if (isOff(value)) {
      store.setInitials([]);
      await store.save();
      return "🚫 Filtro de iniciales desactivado.";
    }
    // Acepta "A M", "A,M" o "AM": se queda con las letras sueltas.
    const letters = [...new Set(
      splitList(value)
        .join(" ")
        .split(/[^\p{L}]+/u)
        .join("")
        .toLowerCase()
        .split(""),
    )].filter(Boolean);
    if (!letters.length) {
      return `⚠️ Indica las iniciales. Ej: *${ctx.prefix}lobby iniciales A M* (el nombre debe empezar por una de ellas).`;
    }
    store.setInitials(letters);
    await store.save();
    return `🚫 Solo pasan al general los nombres que empiezan por: *${letters.join(", ").toUpperCase()}*.`;
  }

  if (sub === "excusa" || sub === "excuse") {
    const rest = String(ctx.commandBody || "").trim().replace(/^\S+\s*/, "").trim();
    if (!rest) {
      return [
        `⚠️ Escribe la excusa. Ej: *${ctx.prefix}lobby excusa Estamos llenos, te avisamos pronto.*`,
        `_(o *${ctx.prefix}lobby excusa reset* para las de por defecto)_`,
      ].join("\n");
    }
    if (["reset", "por defecto", "defecto"].includes(normalize(rest))) {
      store.setExcuse("");
      await store.save();
      return "♻️ Excusa restablecida a las de por defecto (cupo lleno / lista de espera).";
    }
    store.setExcuse(rest);
    await store.save();
    return `✅ Excusa guardada:\n\n${rest}`;
  }

  if (sub === "filtros" || sub === "filtro") {
    return [
      "🚫 *Filtros de admisión*",
      "",
      renderFilters(store.config()),
      "",
      `• *${ctx.prefix}lobby edad 18* — edad mínima (\`off\` para quitar).`,
      `• *${ctx.prefix}lobby paises Colombia, México* — países aceptados (\`off\`).`,
      `• *${ctx.prefix}lobby iniciales A M* — iniciales del nombre (\`off\`).`,
      `• *${ctx.prefix}lobby excusa <texto>* — excusa propia (\`reset\`).`,
      "",
      "Quien no cumpla recibe una excusa creíble, no el link del general.",
    ].join("\n");
  }

  if (sub !== "ver" && sub !== "estado" && sub !== "status") {
    return [
      "*Lobby automático*",
      `• ${ctx.prefix}lobby ver`,
      `• ${ctx.prefix}lobby on | off`,
      `• ${ctx.prefix}lobby aqui lobby | aqui general`,
      `• ${ctx.prefix}lobby demora <segundos>`,
      `• ${ctx.prefix}lobby edad <años> | paises <lista> | iniciales <letras> | excusa <texto> | filtros`,
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
    `• Filtros: ${renderFilters(config)}`,
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
