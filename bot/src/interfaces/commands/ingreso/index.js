import { MSG } from "../../../shared/messages.js";
import { getGroupAdminAuth } from "../../../shared/utils/groupAuth.js";
import { renderFilters } from "../../../shared/utils/ingresoFilters.js";

// `!ingreso` configura el flujo automático de entrada al clan.
//
//   !ingreso lobby           (se ejecuta EN el grupo Lobby)
//   !ingreso general         (se ejecuta EN el grupo general/definitivo)
//   !ingreso delay 15        segundos antes de saludar y arrancar la ficha
//   !ingreso link            enlace del grupo general (se manda al terminar la ficha)
//   !ingreso edad 18         edad mínima para pasar al general (off = sin filtro)
//   !ingreso paises Colombia, México
//   !ingreso iniciales A M
//   !ingreso excusa <texto>  excusa propia cuando no cumple (reset = por defecto)
//   !ingreso filtros         resumen de los filtros
//   !ingreso on | off
//   !ingreso ver | reset
//
// Con `on`: aprueba solo las solicitudes del Lobby, saluda con retraso, inicia
// la ficha, y al aprobar en General saca al miembro del Lobby. Si la ficha no
// cumple los filtros, recibe una excusa creíble y no se le da el enlace.

const MIN_DELAY_S = 0;
const MAX_DELAY_S = 600;

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function seconds(ms) {
  return Math.round((Number(ms) || 0) / 1000);
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

export const ingresoPlugin = {
  name: "ingreso",
  version: "1.0.0",

  register(api, options = {}) {
    let storePromise = null;
    async function getStore() {
      if (options.store) return options.store;
      if (!storePromise) {
        storePromise = import("../../../infrastructure/storage/ingresoStore.js")
          .then(({ getIngresoStore }) => getIngresoStore());
      }
      return storePromise;
    }

    api.register(async (ctx) => {
      if (ctx.command !== "ingreso") return null;
      if (!ctx.isGroup) return MSG.SOLO_GRUPOS;

      const auth = await getGroupAdminAuth(ctx, options.ownerPolicy);
      if (!auth.ok) return auth.reason;

      const store = await getStore();
      if (typeof store.ready === "function") await store.ready().catch(() => {});

      const action = normalize(ctx.args[0] || "ver");
      const config = store.config();

      if (action === "ver" || action === "estado") {
        return [
          "🚪 *Ingreso automático*",
          "",
          `Estado: ${config.enabled ? "✅ activo" : "❌ apagado"}`,
          `Lobby: ${config.lobby ? `\`${config.lobby}\`` : "(sin configurar)"}`,
          `General: ${config.general ? `\`${config.general}\`` : "(sin configurar)"}`,
          `Espera: ${seconds(config.delayMs)} s`,
          `Filtros: ${renderFilters(config)}`,
          config.excuse ? "Excusa: personalizada" : "Excusa: por defecto (cupo lleno)",
          "",
          "Configura con *!ingreso lobby* (en el Lobby) y *!ingreso general* (en el grupo final).",
        ].join("\n");
      }

      if (action === "link" || action === "enlace") {
        if (!config.general) return "⚠️ Primero ejecuta *!ingreso general* en el grupo final.";
        const link = await options.inviteLink?.(`${config.general}@g.us`);
        if (!link) return "⚠️ No pude generar el enlace del grupo general. Comprueba que el bot esté dentro y sea admin.";
        return `🔗 *Enlace del grupo general*\n\n${link}\n\nSe manda al terminar la ficha en el Lobby.`;
      }

      if (action === "lobby") {
        store.setLobby(ctx.phone);
        await store.save();
        return [
          "✅ *Este grupo queda como Lobby.*",
          "",
          "Aquí se aprueban solas las solicitudes de entrada.",
          config.general ? "General: `" + config.general + "`" : "Falta configurar el grupo general: ejecuta *!ingreso general* allí.",
          "",
          "Actívalo con *!ingreso on*.",
        ].join("\n");
      }

      if (action === "general") {
        store.setGeneral(ctx.phone);
        await store.save();
        return [
          "✅ *Este grupo queda como General.*",
          "",
          "Cuando el bot apruebe aquí a un miembro, lo sacará del Lobby automáticamente.",
          config.lobby ? "Lobby: `" + config.lobby + "`" : "Falta configurar el Lobby: ejecuta *!ingreso lobby* allí.",
        ].join("\n");
      }

      if (action === "delay" || action === "espera") {
        // `Number("")` es 0, no NaN: sin este guard un `delay abc` ponía 0 s.
        const digits = String(ctx.args[1] || "").replace(/[^\d.]/g, "");
        const value = digits ? Number(digits) : NaN;
        if (!Number.isFinite(value) || value < MIN_DELAY_S || value > MAX_DELAY_S) {
          return `⚠️ Indica los segundos de espera (${MIN_DELAY_S}–${MAX_DELAY_S}). Ej: *!ingreso delay 15*`;
        }
        store.setDelay(Math.round(value * 1000));
        await store.save();
        return `⏱️ Espera configurada: *${Math.round(value)} s* antes de saludar y arrancar la ficha.`;
      }

      if (action === "edad" || action === "age") {
        const value = ctx.args[1] || "";
        if (isOff(value)) {
          store.setMinAge(0);
          await store.save();
          return "🚫 Filtro de edad desactivado.";
        }
        const age = parseAgeArg(value);
        if (!age) return "⚠️ Indica la edad mínima (1–99). Ej: *!ingreso edad 18* (o *!ingreso edad off*).";
        store.setMinAge(age);
        await store.save();
        return `🚫 Solo pasan al general las personas de *${age} años o más*.`;
      }

      if (action === "paises" || action === "pais" || action === "countries") {
        const value = ctx.args.slice(1).join(" ");
        if (isOff(value)) {
          store.setCountries([]);
          await store.save();
          return "🚫 Filtro de país desactivado.";
        }
        const list = splitList(value);
        if (!list.length) {
          return "⚠️ Indica los países separados por coma. Ej: *!ingreso paises Colombia, México, Perú*";
        }
        store.setCountries(list);
        await store.save();
        return `🚫 Solo pasan al general los países: *${list.join(", ")}*.`;
      }

      if (action === "iniciales" || action === "inicial") {
        const value = ctx.args.slice(1).join(" ");
        if (isOff(value)) {
          store.setInitials([]);
          await store.save();
          return "🚫 Filtro de iniciales desactivado.";
        }
        const letters = [...new Set(
          splitList(value)
            .join(" ")
            .split(/[^\p{L}]+/u)
            .join("")
            .toLowerCase()
            .split(""),
        )].filter(Boolean);
        if (!letters.length) {
          return "⚠️ Indica las iniciales. Ej: *!ingreso iniciales A M* (el nombre debe empezar por una de ellas).";
        }
        store.setInitials(letters);
        await store.save();
        return `🚫 Solo pasan al general los nombres que empiezan por: *${letters.join(", ").toUpperCase()}*.`;
      }

      if (action === "excusa" || action === "excuse") {
        const rest = String(ctx.commandBody || "").trim().replace(/^\S+\s*/, "").trim();
        if (!rest) {
          return "⚠️ Escribe la excusa. Ej: *!ingreso excusa Estamos llenos, te avisamos pronto.*\n_(o *!ingreso excusa reset* para las de por defecto)_";
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

      if (action === "filtros" || action === "filtro") {
        return [
          "🚫 *Filtros de ingreso*",
          "",
          renderFilters(config),
          "",
          "• *!ingreso edad 18* — edad mínima (`off` para quitar).",
          "• *!ingreso paises Colombia, México* — países aceptados (`off`).",
          "• *!ingreso iniciales A M* — iniciales del nombre (`off`).",
          "• *!ingreso excusa <texto>* — excusa propia (`reset`).",
          "",
          "Quien no cumpla recibe la excusa, no el enlace del general.",
        ].join("\n");
      }

      if (action === "on" || action === "activar") {
        if (!config.lobby) return "⚠️ Primero ejecuta *!ingreso lobby* en el grupo Lobby.";
        if (!config.general) return "⚠️ Primero ejecuta *!ingreso general* en el grupo final.";
        store.setEnabled(true);
        await store.save();
        return [
          "✅ *Ingreso automático activado.*",
          "",
          "• Apruebo solo las solicitudes del Lobby.",
          `• Saludo y arranco la ficha tras ${seconds(store.config().delayMs)} s.`,
          "• Al aprobarte en General, te saco del Lobby.",
          `• Filtros: ${renderFilters(store.config())}.`,
        ].join("\n");
      }

      if (action === "off" || action === "desactivar") {
        store.setEnabled(false);
        await store.save();
        return "🚪 Ingreso automático desactivado.";
      }

      if (action === "reset" || action === "borrar") {
        store.reset();
        await store.save();
        return "🗑️ Configuración de ingreso borrada.";
      }

      return [
        "Uso: *!ingreso* ver | on | off | lobby | general | delay <segundos> | link | reset",
        "Filtros: *!ingreso* edad <años> | paises <lista> | iniciales <letras> | excusa <texto> | filtros",
        "",
        "• Ejecuta *!ingreso lobby* dentro del grupo Lobby.",
        "• Ejecuta *!ingreso general* dentro del grupo final.",
      ].join("\n");
    }, {
      commands: ["ingreso"],
      category: "ADMINISTRACION",
    });
  },
};
