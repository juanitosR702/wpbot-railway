import { HALT } from "../../bot/router.js";
import { MSG } from "../../../shared/messages.js";
import { jidUser, findParticipant, isAdminParticipant } from "../../../shared/utils/jid.js";
import {
  DEFAULT_FICHA,
  FICHA_PRESETS,
  MAX_LIST_OPTIONS,
  formatFichaDate,
  formSteps,
  parseFichaText,
  parseFieldLines,
  renderFicha,
  renderFormConfig,
  rowTitle,
  validateFichaValues,
} from "../../../shared/utils/fichaForm.js";
import {
  parseRouteCondition,
  renderRoutes,
  resolveFichaTargets,
} from "../../../shared/utils/fichaRoutes.js";

// Sesiones en memoria: cada persona llena su ficha en su propio chat/grupo.
// Sin Mongo a propósito: si el bot reinicia, la ficha a medias se pierde y se
// vuelve a empezar (no hay nada que recuperar).
const SESSION_TTL_MS = 20 * 60 * 1000;
const sessions = new Map();

// WhatsApp puede entregar al mismo remitente como teléfono (`@s.whatsapp.net`)
// o como LID (`@lid`), y hasta cambiar entre mensajes. Se guarda la sesión bajo
// todas las variantes para que no se pierda a mitad de la ficha: ese era el
// motivo de que el flujo se quedara mudo en un paso.
function senderIds(ctx) {
  return [...new Set(
    [
      ctx.sender,
      ctx.raw?.key?.participant,
      ctx.raw?.key?.participantPn,
      ctx.raw?.key?.participantLid,
      ctx.raw?.key?.participantAlt,
    ]
      .filter(Boolean)
      .map((id) => jidUser(id)),
  )];
}

function findSession(ctx) {
  for (const id of senderIds(ctx)) {
    const session = sessions.get(`${id}:${ctx.phone}`);
    if (session) return session;
  }
  return null;
}

function saveSession(ctx, session) {
  const ids = senderIds(ctx);
  if (!ids.length) ids.push(ctx.sender);
  for (const id of ids) sessions.set(`${id}:${ctx.phone}`, session);
}

function dropSession(ctx, session) {
  const target = session || findSession(ctx);
  if (!target) return;
  for (const [key, value] of sessions) {
    if (value === target) sessions.delete(key);
  }
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function isOmit(text) {
  return ["omitir", "skip", "no", "-", "ninguno"].includes(normalize(text));
}

export const fichaPlugin = {
  name: "fichas",
  version: "1.0.0",

  register(api, options = {}) {
    const ownerPolicy = options.ownerPolicy;

    // Carga diferida: el store importa Mongo, así el plugin se puede testear
    // (o cargar) sin base de datos inyectando `options.store`.
    let storePromise = null;
    async function getStore() {
      if (options.store) return options.store;
      if (!storePromise) {
        storePromise = import("../../../infrastructure/storage/fichaStore.js")
          .then(({ getFichaStore }) => getFichaStore());
      }
      return storePromise;
    }

    api.register(async (ctx) => {
      const store = await getStore();
      if (typeof store.ready === "function") await store.ready().catch(() => {});

      if (!ctx.isCommand) return handleSession(ctx, store, options);

      if (ctx.command === "ficha") return startFicha(ctx, store);
      if (ctx.command === "setficha") return configure(ctx, store, options);
      if (ctx.command === "fichadestino") return setDestination(ctx, store, options);
      if (ctx.command === "rutas" || ctx.command === "ruta") return manageRoutes(ctx, store, options);
      return null;
    }, {
      commands: ["ficha", "setficha", "fichadestino", "rutas"],
      category: "FICHAS",
    });
  },
};

// ---- Flujo de llenado ----

async function startFicha(ctx, store) {
  if (!ctx.isGroup) return MSG.SOLO_GRUPOS;

  if (findSession(ctx)) {
    return "⚠️ Ya tienes una ficha en curso. Escribe *cancelar* para salir.";
  }

  if (!store.destination()) {
    return "⚠️ Todavía no hay un grupo de almacenamiento de fichas.\nUn admin debe ejecutar *!fichadestino* en ese grupo.";
  }

  const form = store.form(ctx.phone) || DEFAULT_FICHA;
  const steps = formSteps(form);
  if (!steps.length) {
    return "⚠️ La ficha de este grupo no tiene campos. Un admin puede configurarla con *!setficha*.";
  }

  const session = { phase: "fill", step: 0, values: {}, form, steps, editing: null, at: Date.now() };
  saveSession(ctx, session);
  return sendPrompt(ctx, session);
}

async function handleSession(ctx, store, options) {
  const session = findSession(ctx);
  if (!session) return null;

  if (Date.now() - session.at > SESSION_TTL_MS) {
    dropSession(ctx, session);
    return "⌛ La ficha caducó por inactividad. Empieza de nuevo con *!ficha*.";
  }

  const selection = String(ctx.selection || "");
  const text = String(ctx.text || "").trim();

  console.log(
    `[ficha] ${ctx.phone} fase=${session.phase} paso=${session.step} `
    + `texto=${JSON.stringify(text.slice(0, 40))} seleccion=${selection || "-"}`,
  );

  if (selection === "f:x" || /^(cancelar|cancel|salir)$/i.test(text)) {
    dropSession(ctx, session);
    return "❌ Ficha cancelada.";
  }

  session.at = Date.now();

  if (session.phase === "config") return handleConfigAnswer(ctx, store, session, text);
  if (session.phase === "fill") return handleFill(ctx, session, text, selection);
  if (session.phase === "edit") return handleEditPick(ctx, session, text, selection);
  if (session.phase === "preview") return handlePreview(ctx, store, session, text, selection, options);
  return null;
}

async function handleFill(ctx, session, text, selection) {
  const step = session.steps[session.step];
  const field = step.field;

  let value = null;

  if (field.options?.length) {
    value = parseOptionSelection(selection, session.step, field.options);
    if (value === null && /^\d{1,2}$/.test(text)) {
      const index = Number(text) - 1;
      if (index >= 0 && index < field.options.length) value = field.options[index];
    }
    if (value === null && text) {
      value = field.options.find((option) => normalize(option) === normalize(text)) || null;
    }
    // Lista vencida, número fuera de rango o texto que no es una opción:
    // se repite la pregunta en vez de guardar basura.
    if (value === null) return sendPrompt(ctx, session);
  } else {
    // Una selección que no corresponde a este paso (lista vieja) no debe
    // dejar la ficha muda: se repite la pregunta.
    if (!text) return sendPrompt(ctx, session);
    if (text.length > 400) return "⚠️ Respuesta demasiado larga (máximo 400 caracteres).";
    value = text;
  }

  session.values[step.index] = value;

  if (session.editing !== null) {
    session.editing = null;
    session.phase = "preview";
    return sendPreview(ctx, session);
  }

  session.step += 1;
  if (session.step >= session.steps.length) {
    session.phase = "preview";
    return sendPreview(ctx, session);
  }

  return sendPrompt(ctx, session);
}

function parseOptionSelection(selection, step, options) {
  const prefix = `f:o:${step}:`;
  if (!selection.startsWith(prefix)) return null;
  const index = Number(selection.slice(prefix.length));
  if (!Number.isInteger(index) || index < 0 || index >= options.length) return null;
  return options[index];
}

async function sendPrompt(ctx, session) {
  const step = session.steps[session.step];
  const field = step.field;
  const progress = `${session.step + 1}/${session.steps.length}`;

  if (field.options?.length) {
    // Las opciones van también en el texto: si WhatsApp falla al pintar la
    // lista, el usuario puede responder con el número.
    const numbered = field.options
      .map((option, index) => `${index + 1}. ${option}`)
      .join("\n");

    await sendList(ctx, {
      text: `📝 *Ficha (${progress})*\n\n${field.label}\n\n${numbered}`,
      footer: "Toca «Ver opciones» o responde con el número.",
      buttonText: "Ver opciones",
      rows: field.options.map((option, index) => ({
        rowId: `f:o:${session.step}:${index}`,
        title: rowTitle(option),
      })),
    });
    return HALT;
  }

  await ctx.sendMessage({
    text: `📝 *Ficha (${progress})*\n\n${field.label}\n\n_Escribe *cancelar* para salir._`,
  });
  return HALT;
}

async function sendPreview(ctx, session) {
  const body = [
    "📋 *Revisa tu ficha*",
    "",
    renderFicha(session.form, session.values),
    "",
    "¿La envío al grupo de almacenamiento?",
    "",
    "1. ✅ Enviar ficha",
    "2. ✏️ Corregir un campo",
    "3. ❌ Cancelar",
  ].join("\n");

  await sendList(ctx, {
    text: body,
    footer: "Toca un botón o responde con el número.",
    buttonText: "Elegir",
    rows: [
      { rowId: "f:s", title: "✅ Enviar ficha" },
      { rowId: "f:e", title: "✏️ Corregir un campo" },
      { rowId: "f:x", title: "❌ Cancelar" },
    ],
  });
  return HALT;
}

async function handlePreview(ctx, store, session, text, selection, options = {}) {
  const word = normalize(text);
  const pick = selection === "f:s" || word === "1"
    ? "send"
    : selection === "f:e" || word === "2"
      ? "edit"
      : selection === "f:x" || word === "3"
        ? "cancel"
        : null;

  if (pick === "send" || (!pick && /^(enviar|si|confirmar|listo|ok)$/.test(word))) {
    return submitFicha(ctx, store, session, options);
  }

  if (pick === "edit" || (!pick && /^(corregir|editar|cambiar)$/.test(word))) {
    session.phase = "edit";
    return sendEditPicker(ctx, session);
  }

  if (pick === "cancel" || selection === "f:x") {
    dropSession(ctx, session);
    return "❌ Ficha cancelada.";
  }

  return "Elige una opción: *1* enviar, *2* corregir o *3* cancelar.";
}

async function sendEditPicker(ctx, session) {
  const rows = session.steps.map((step, index) => ({
    rowId: `f:p:${index}`,
    title: rowTitle(step.field.label),
  }));

  if (rows.length <= MAX_LIST_OPTIONS) {
    await sendList(ctx, {
      text: "✏️ *¿Qué campo quieres corregir?*",
      footer: "Escribe *cancelar* para salir.",
      buttonText: "Campos",
      rows,
    });
    return HALT;
  }

  const lines = session.steps.map((step, index) => `${index + 1}. ${step.field.label}`).join("\n");
  await ctx.sendMessage({ text: `✏️ *¿Qué campo quieres corregir?*\n\n${lines}\n\nResponde con el número.` });
  return HALT;
}

async function handleEditPick(ctx, session, text, selection) {
  let index = null;

  if (selection.startsWith("f:p:")) index = Number(selection.slice(4));
  else if (/^\d{1,2}$/.test(text)) index = Number(text) - 1;

  if (!Number.isInteger(index) || index < 0 || index >= session.steps.length) {
    return "Elige un campo de la lista.";
  }

  session.phase = "fill";
  session.step = index;
  session.editing = index;
  return sendPrompt(ctx, session);
}

async function submitFicha(ctx, store, session, options = {}) {
  // Revisión final: si algo llegó mal (edad fuera de rango, un "No" en las
  // reglas, un texto vacío) se vuelve a preguntar solo ese campo en vez de
  // mandar una ficha incompleta al grupo de almacenamiento.
  const validation = validateFichaValues(session.form, session.values);
  if (!validation.ok) {
    session.phase = "fill";
    session.step = validation.firstIndex ?? 0;
    session.editing = null;
    await ctx.sendMessage({
      text: ["⚠️ *Revisa tu ficha:*", "", ...validation.errors.map((error) => `• ${error.message}`)].join("\n"),
    });
    await sendPrompt(ctx, session);
    return HALT;
  }

  // La ficha va SIEMPRE al grupo de almacén (!fichadestino). Las rutas de
  // *!rutas* no cambian el destino de la ficha: deciden a qué grupos se añade
  // a la persona.
  const destination = store.destination();
  if (!destination) {
    return "⚠️ No hay grupo de almacenamiento configurado. Un admin debe ejecutar *!fichadestino* en ese grupo.";
  }

  const metadata = await safeGroupMetadata(ctx);
  // El remitente puede venir como LID (`123...@lid`); en la ficha debe salir su
  // número de teléfono, igual que la mención.
  const senderJid = phoneSenderJid(ctx, metadata);
  const text = renderFicha(session.form, session.values, {
    senderNumber: jidUser(senderJid),
    senderName: ctx.name && ctx.name !== ctx.sender ? ctx.name : "",
    groupName: metadata?.subject || "",
    date: formatFichaDate(),
  });

  try {
    await ctx.services.sendMessage(destination, { text, mentions: [senderJid] });
  } catch (err) {
    console.error("[ficha] no se pudo enviar al grupo destino:", err?.message || err);
    return "⚠️ No pude enviar la ficha al grupo de almacenamiento. Avisa a un admin.";
  }

  dropSession(ctx, session);

  // Gancho del lobby: marca a la persona como fichada y le manda el link del
  // grupo general por privado. Devuelve el texto que se añade a la respuesta.
  let extra = "";
  try {
    extra = (await options.onSubmitted?.(ctx, { store, session })) || "";
  } catch (err) {
    console.warn("[ficha] error en el gancho onSubmitted:", err?.message || err);
  }

  // Reparto por rutas: añadir a la persona a los grupos que le toquen.
  const { notes } = await deliverByRoutes(ctx, store, session);

  return ["✅ *Ficha enviada* al grupo de almacenamiento. ¡Gracias!", ...notes, extra]
    .filter(Boolean)
    .join("\n\n");
}

// ---- Reparto: añadir a la persona a los grupos de sus rutas ----

function inviteUrl(code) {
  const value = String(code || "").trim();
  if (!value) return "";
  return /^https?:/i.test(value) ? value : `https://chat.whatsapp.com/${value}`;
}

// WhatsApp solo deja añadir por número de teléfono, así que se prueban primero
// las variantes `@s.whatsapp.net` que trae el mensaje.
function addCandidates(ctx) {
  const key = ctx.raw?.key || {};
  const ids = [key.participantPn, key.participantAlt, ctx.sender, key.participant, key.participantLid]
    .filter(Boolean)
    .map((id) => String(id));
  const phone = ids.filter((id) => id.endsWith("@s.whatsapp.net"));
  const rest = ids.filter((id) => !id.endsWith("@s.whatsapp.net"));
  return [...new Set([...phone, ...rest])];
}

async function tryAddToGroup(ctx, jid) {
  const update = ctx.services?.updateParticipants;
  if (typeof update !== "function") return false;

  for (const participant of addCandidates(ctx)) {
    try {
      const result = await update(jid, [participant], "add");
      const entry = Array.isArray(result) ? result[0] : result;
      const status = String(entry?.status ?? entry?.error ?? "");
      if (!entry || status === "200" || status === "409" || status === "success") return true;
    } catch (err) {
      console.warn(`[ficha] no pude añadir a ${participant} en ${jid}:`, err?.message || err);
    }
  }
  return false;
}

// WhatsApp entrega al remitente como teléfono o como LID (y cambia entre
// mensajes). La ficha debe mostrar siempre el número: se busca la variante
// `@s.whatsapp.net` en el mensaje y, si no está, en la metadata del grupo.
function phoneSenderJid(ctx, metadata) {
  const key = ctx.raw?.key || {};
  const ids = [key.participantPn, key.participantAlt, key.participant, ctx.sender]
    .filter(Boolean)
    .map((id) => String(id));
  const participant = findParticipant(metadata, ids);
  const all = [
    participant?.phoneNumber,
    participant?.id,
    ...ids,
  ].filter(Boolean).map((id) => String(id));
  return all.find((id) => id.endsWith("@s.whatsapp.net")) || String(ctx.sender || "");
}

function currentGroupJid(ctx) {
  const phone = String(ctx.phone || "").trim();
  return phone.endsWith("@g.us") ? phone : `${phone}@g.us`;
}

// Si la persona ya está en el grupo no se vuelve a "añadir": evita errores y
// molesta menos cuando alguien manda dos veces la ficha.
async function isAlreadyMember(ctx, jid, participantId) {
  if (!participantId) return false;
  try {
    const meta = await ctx.services?.getGroupMetadata?.(jid);
    return Boolean(findParticipant(meta, [participantId]));
  } catch {
    return false;
  }
}

async function groupNamesFor(ctx, jids) {
  const names = {};
  for (const jid of jids) {
    try {
      const meta = await ctx.services?.getGroupMetadata?.(jid);
      if (meta?.subject) names[jid] = meta.subject;
    } catch {
      // Sin nombre disponible.
    }
  }
  return names;
}

async function groupNames(ctx, routes) {
  const names = {};
  for (const route of routes) {
    try {
      const meta = await ctx.services?.getGroupMetadata?.(route.jid);
      if (meta?.subject) names[route.jid] = meta.subject;
    } catch {
      // Sin nombre disponible: se muestra el JID igualmente.
    }
  }
  return names;
}

async function routeInviteLink(ctx, route) {
  const direct = String(route?.invite || "").trim();
  if (/^https?:/i.test(direct)) return direct;
  try {
    const code = await ctx.services?.inviteCode?.(route.jid);
    return inviteUrl(code);
  } catch (err) {
    console.warn(`[ficha] no pude obtener el link de ${route.jid}:`, err?.message || err);
    return "";
  }
}

async function deliverByRoutes(ctx, store, session) {
  const routes = typeof store.routes === "function" ? store.routes() : [];
  if (!routes.length) return { notes: [] };

  // Solo cuentan las rutas de la comunidad donde se llenó la ficha.
  const meta = await safeGroupMetadata(ctx);
  const scope = meta?.linkedParent || "";
  const { sends, fallback } = resolveFichaTargets(routes, session.form, session.values, { scope });
  if (!sends.length) return { notes: [] };

  const added = [];
  const invited = [];
  const failed = [];
  const already = [];
  const privateJid = addCandidates(ctx).find((id) => id.endsWith("@s.whatsapp.net")) || ctx.sender;
  const personJid = phoneSenderJid(ctx, meta);

  for (const target of sends) {
    const nombre = target.name ? `*${target.name}*` : "el grupo";
    if (await isAlreadyMember(ctx, target.jid, personJid)) {
      already.push(nombre);
      continue;
    }
    if (await tryAddToGroup(ctx, target.jid)) {
      added.push(nombre);
      continue;
    }

    const link = await routeInviteLink(ctx, target);
    if (!link) {
      failed.push(nombre);
      continue;
    }

    try {
      await ctx.services.sendMessage(privateJid, {
        text: [
          `📩 No pude añadirte a ${nombre}.`,
          "",
          "WhatsApp solo deja añadir directamente a números que tenga guardados, así que entra con este link:",
          link,
        ].join("\n"),
      });
      invited.push(nombre);
    } catch (err) {
      console.warn(`[ficha] no pude mandar el link de ${target.jid} por privado:`, err?.message || err);
      failed.push(nombre);
    }
  }

  console.log(`[ficha] rutas${fallback ? " (comodín)" : ""}: añadidos=${added.length} ya_estaba=${already.length} link=${invited.length} fallos=${failed.length}`);

  const notes = [];
  if (added.length) notes.push(`✅ Te añadí a ${added.join(", ")}.`);
  if (already.length) notes.push(`ℹ️ Ya estabas en ${already.join(", ")}.`);
  if (invited.length) notes.push(`📩 Te mandé por privado el link de ${invited.join(", ")}.`);
  if (failed.length) notes.push(`⚠️ No pude gestionar tu entrada en ${failed.join(", ")}. Avisa a un admin.`);
  return { notes };
}

// ---- Listas interactivas con respaldo a texto ----
//
// `ctx.sendList` construye un `interactiveMessage` con botón `single_select`
// (Baileys v6 no acepta `sections` en `sendMessage`). Si el transporte no la
// soporta o WhatsApp la rechaza, se manda el mismo menú numerado para no dejar
// al usuario bloqueado.

async function sendList(ctx, { text, footer, buttonText, rows }) {
  try {
    const sent = await ctx.sendList({ text, footer, buttonText, rows });
    if (sent) return sent;
  } catch (err) {
    console.warn("[ficha] la lista interactiva falló, usando texto:", err?.message || err);
  }

  // El texto ya trae las opciones numeradas; solo se reenvía como mensaje
  // normal para que el usuario nunca se quede sin ver el menú.
  return ctx.sendMessage({ text });
}

// ---- Configuración ----

async function configure(ctx, store, options) {
  if (!ctx.isGroup) return MSG.SOLO_GRUPOS;

  const auth = await getAdmin(ctx, options.ownerPolicy);
  if (!auth.ok) return auth.reason;

  const action = normalize(ctx.args[0] || "");

  if (action === "dragon" || action === "ghost") {
    const preset = FICHA_PRESETS.dragon;
    store.setForm(ctx.phone, preset, ctx.sender);
    await store.save();
    return [
      "✅ *Ficha de GHOST DRAGONS instalada en este grupo.*",
      "",
      renderFicha(preset, {}),
      "",
      "Los miembros ya pueden llenarla con *!ficha*.",
      "Puedes ajustarla con *!setficha* (o volver a la genérica con *!setficha reset*).",
    ].join("\n");
  }

  if (action === "ver" || action === "show") {
    const custom = store.form(ctx.phone);
    const form = custom || DEFAULT_FICHA;
    const note = custom ? "" : "\n_(usando la ficha por defecto)_";
    return [
      `⚙️ *Ficha de este grupo*${note}`,
      "",
      renderFormConfig(form),
      "",
      `Para cambiarla: *${ctx.prefix}setficha importar* (pegas el texto) o *${ctx.prefix}setficha guia*.`,
    ].join("\n");
  }

  if (["guia", "guía", "ayuda", "como", "cómo", "ejemplo"].includes(action)) {
    return [
      "🧭 *Cómo configurar la ficha*",
      "",
      `*Forma rápida:* escribe *${ctx.prefix}setficha importar* y debajo pega la ficha completa.`,
      "",
      "Ejemplo (cópialo y cámbialo):",
      `${ctx.prefix}setficha importar`,
      "🐉 FICHA DE INGRESO",
      "CAMPOS",
      "# DATOS DEL INTEGRANTE",
      "Nombre o apodo",
      "Edad",
      "País | Colombia, México, Perú, Otro",
      "# COMPROMISO",
      "¿Aceptas las reglas? | Sí, No",
      "PIE: Gracias por tu interés.",
      "",
      "*Qué es cada cosa:*",
      "• Lo que va *antes* de CAMPOS = encabezado (título de la ficha).",
      "• Cada línea de CAMPOS = *una pregunta*, salvo `# SECCION`.",
      "• `Campo | a, b, c` = desplegable (máx. 9 opciones).",
      "• Las *reglas* (viñetas, “1. …”, frases) NO se preguntan: se guardan como texto de cierre.",
      "• `PIE:` = despedida final.",
      "",
      "*Otras formas:*",
      `• *${ctx.prefix}setficha* — asistente de 3 pasos (encabezado, campos, pie).`,
      `• *${ctx.prefix}setficha dragon* — instala la ficha de GHOST DRAGONS.`,
      `• *${ctx.prefix}setficha ver* — muestra la ficha actual.`,
      `• *${ctx.prefix}setficha reset* — vuelve a la genérica.`,
      "",
      `Los filtros de admisión (edad mínima, países) van aparte: *${ctx.prefix}lobby filtros*.`,
    ].join("\n");
  }

  // Carga de una sola vez: el admin (o la IA) pega la ficha completa y se
  // guarda sin pasar por el asistente de 3 pasos.
  if (["importar", "pegar", "texto", "rapido", "rápido", "import"].includes(action)) {
    const raw = String(ctx.commandBody || "").trim().replace(/^\S+\s*/, "").trim();
    if (!raw) {
      return [
        "⚠️ Pega la ficha después de *!setficha importar*.",
        "",
        "Ejemplo:",
        "!setficha importar",
        "ENCABEZADO: 🐉 FICHA DE INGRESO",
        "CAMPOS",
        "# DATOS DEL INTEGRANTE",
        "Nombre o apodo",
        "Edad",
        "País | Colombia, México, Perú, Otro",
        "PIE: Gracias por tu interés.",
      ].join("\n");
    }

    let form;
    try {
      form = parseFichaText(raw);
    } catch (err) {
      return `⚠️ ${err.message}\n\nCorrige el texto y envíalo de nuevo.`;
    }

    store.setForm(ctx.phone, form, ctx.sender);
    await store.save();

    const reglas = Number(form.notes) || 0;
    const notaReglas = reglas
      ? `_${reglas} línea(s) de reglas guardadas como texto de cierre (no se preguntan)._`
      : "";

    return [
      "✅ *Ficha guardada para este grupo.*",
      "",
      renderFormConfig(form),
      "",
      notaReglas,
      "Los miembros ya pueden llenarla con *!ficha*.",
      `Ajusta los filtros con *${ctx.prefix}lobby filtros edad=18; paises=Colombia, México* (o *${ctx.prefix}lobby filtros* para verlos).`,
    ].join("\n");
  }

  if (action === "reset" || action === "reiniciar") {
    store.clearForm(ctx.phone);
    await store.save();
    return "♻️ Ficha reiniciada a la predeterminada.";
  }

  if (findSession(ctx)) {
    return "⚠️ Ya tienes una configuración en curso. Escribe *cancelar* para salir.";
  }

  const session = {
    phase: "config",
    step: 0,
    data: { header: "", fields: [], footer: "" },
    at: Date.now(),
  };
  saveSession(ctx, session);

  return [
    "⚙️ *Configurar ficha* (1/3)",
    "",
    "Envía el *encabezado* de la ficha. Puede tener varias líneas y emojis:",
    "🐉 𓆩 GHOST DRAGONS 𓆪 🐉",
    "✦ FICHA DE INGRESO ✦",
    "",
    "Escribe *omitir* para no usar encabezado o *cancelar* para salir.",
    "",
    "⚡ Atajo: *!setficha dragon* instala la ficha de GHOST DRAGONS ya lista.",
  ].join("\n");
}

async function handleConfigAnswer(ctx, store, session, text) {
  if (!text) return null;

  if (session.step === 0) {
    session.data.header = isOmit(text) ? "" : text;
    session.step = 1;
    return [
      "⚙️ *Configurar ficha* (2/3)",
      "",
      "Envía los *campos*, uno por línea:",
      "• `# SECCIÓN` → título de sección",
      "• `Campo | opción 1, opción 2` → desplegable",
      "• `Campo` → texto libre",
      "",
      "Ejemplo:",
      "# DATOS DEL INTEGRANTE",
      "Nombre o apodo",
      "País | Colombia, México, Perú, Otro",
      "¿Aceptas las reglas? | Sí, No",
    ].join("\n");
  }

  if (session.step === 1) {
    try {
      session.data.fields = parseFieldLines(text);
    } catch (err) {
      return `⚠️ ${err.message}\n\nCorrige la lista y envíala de nuevo.`;
    }
    session.step = 2;
    return [
      "⚙️ *Configurar ficha* (3/3)",
      "",
      "Envía el *pie* de la ficha (mensaje de cierre) o escribe *omitir*.",
    ].join("\n");
  }

  session.data.footer = isOmit(text) ? "" : text;

  const form = {
    header: session.data.header,
    fields: session.data.fields,
    footer: session.data.footer,
  };
  store.setForm(ctx.phone, form, ctx.sender);
  await store.save();
  dropSession(ctx, session);

  return [
    "✅ *Ficha guardada para este grupo.*",
    "",
    renderFicha(form, {}),
    "",
    "Los miembros ya pueden llenarla con *!ficha*.",
  ].join("\n");
}

async function setDestination(ctx, store, options) {
  if (!ctx.isGroup) return MSG.SOLO_GRUPOS;

  const auth = await getAdmin(ctx, options.ownerPolicy);
  if (!auth.ok) return auth.reason;

  const action = normalize(ctx.args[0] || "");

  if (action === "ver" || action === "estado") {
    const destination = store.destination();
    const routeCount = typeof store.routes === "function" ? store.routes().length : 0;
    const lines = [];
    lines.push(destination ? `📥 Almacén clásico: ${destination}` : "⚠️ Sin almacén clásico configurado.");
    lines.push(routeCount ? `🧭 Rutas activas: ${routeCount} (ver *!rutas ver*)` : "🧭 Sin rutas: todas las fichas van al almacén clásico.");
    return lines.join("\n");
  }

  if (["off", "quitar", "ninguno", "borrar"].includes(action)) {
    store.setDestination("");
    await store.save();
    return "🗑️ Almacén de fichas desactivado.";
  }

  // Se acepta un JID explícito; si no, se usa el grupo donde se ejecutó.
  // `ctx.phone` viene normalizado (sin `@g.us`), así que hay que reconstruir el
  // JID del grupo: enviar a un número suelto lo trataría como chat privado.
  const raw = String(ctx.commandBody || "").trim();
  const explicit = raw.match(/(\d{10,})@g\.us/)?.[1] || null;
  const destination = explicit ? `${explicit}@g.us` : currentGroupJid(ctx);

  store.setDestination(destination);
  await store.save();

  try {
    await ctx.services.sendMessage(destination, {
      text: "📥 *Este grupo queda como almacén de fichas.*\nLas fichas de ingreso se publicarán aquí.",
    });
  } catch (err) {
    return `⚠️ Guardé el destino (${destination}) pero no pude escribir en él: ${err?.message || err}`;
  }

  const extra = explicit && explicit !== ctx.phone ? `\n\n_(Configurado desde otro grupo.)_` : "";
  return `✅ Listo. Las fichas se enviarán a este grupo.${extra}`;
}

// ---- Rutas de destino (varios grupos con condiciones) ----

async function manageRoutes(ctx, store, options) {
  if (!ctx.isGroup) return MSG.SOLO_GRUPOS;

  const auth = await getAdmin(ctx, options.ownerPolicy);
  if (!auth.ok) return auth.reason;

  const action = normalize(ctx.args[0] || "");
  const routes = typeof store.routes === "function" ? store.routes() : [];

  if (!action || ["ver", "lista", "listar"].includes(action)) {
    const meta = await safeGroupMetadata(ctx);
    const names = await groupNames(ctx, routes);
    const communities = await groupNamesFor(ctx, [...new Set(routes.map((route) => route.scope).filter(Boolean))]);
    for (const [scope, subject] of Object.entries(await groupNamesFor(ctx, meta?.linkedParent ? [meta.linkedParent] : []))) {
      communities[scope] = subject;
    }
    return renderRoutes(routes, {
      names,
      communities,
      origin: {
        jid: currentGroupJid(ctx),
        name: meta?.subject || "",
        scope: meta?.linkedParent || "",
      },
    });
  }

  if (["limpiar", "reset", "vaciar"].includes(action)) {
    store.clearRoutes();
    await store.save();
    return "♻️ Rutas de fichas eliminadas.";
  }

  if (["quitar", "off", "borrar", "del", "remove"].includes(action)) {
    const raw = String(ctx.commandBody || "").trim().split(/\s+/).slice(1).join(" ").trim();
    if (!raw) return "Uso: *!rutas quitar <nombre del grupo>* (o *!rutas quitar aqui*)";
    const jid = currentGroupJid(ctx);
    const names = await groupNames(ctx, routes);
    const key = normalize(raw);
    const target = routes.find((route) => (
      normalize(route.name) === key
      || normalize(names[route.jid] || "") === key
      || route.jid === raw
      || (key === "aqui" && route.jid === jid)
    ));
    if (!target) return `⚠️ No encontré ninguna ruta que coincida con «${raw}».\nMíralas con *!rutas ver*.`;
    store.removeRoute(target.name || target.jid);
    await store.save();
    return `🗑️ Ruta *${target.name}* eliminada (${names[target.jid] || target.jid}).`;
  }

  if (["aqui", "add", "agregar", "anadir"].includes(action)) {
    const tokens = String(ctx.commandBody || "").trim().split(/\s+/).filter(Boolean);
    const meta = await safeGroupMetadata(ctx);
    const jid = currentGroupJid(ctx);
    const groupName = String(meta?.subject || "").trim();
    const scope = meta?.linkedParent || "";

    // El nombre es opcional: si no se pone, o si lo que sigue ya es una
    // condición, la ruta se llama igual que el grupo. Nada de inventar nombres.
    let name = tokens[1] || "";
    const firstIsCondition = Boolean(name) && (/link=/i.test(name) || /[=<>]/.test(name) || /^\d+-\d+$/.test(name));
    let rest = tokens.slice(2);
    if (!name || firstIsCondition) {
      name = groupName || "ruta";
      rest = tokens.slice(1);
    }

    const conditions = [];
    let invite = "";
    for (const token of rest) {
      const linkMatch = token.match(/^link=(.+)$/i);
      if (linkMatch) {
        const value = linkMatch[1].trim();
        if (!/^https?:/i.test(value) && !["auto", "propio"].includes(normalize(value))) {
          return "⚠️ El *link=* debe ser una URL que empiece por https:// (o *link=auto* para generar el del grupo).";
        }
        invite = ["auto", "propio"].includes(normalize(value)) ? "auto" : value;
        continue;
      }
      const parsed = parseRouteCondition(token);
      if (!parsed) {
        return `⚠️ No entendí «${token}».\nUsa *campo=valor* (ej: *edad<16*, *pais=colombia|mexico*) o *link=<url>*.`;
      }
      conditions.push(parsed);
    }

    const route = store.addRoute({
      name,
      jid,
      scope,
      invite,
      conditions,
      enabled: true,
      updatedBy: ctx.sender,
    });
    await store.save();

    const nombreGrupo = groupName || jid;
    const detalle = conditions.length
      ? `Recibirá las fichas que cumplan: ${conditions.map((c) => (c.type === "range" ? `${c.field} ${c.min}-${c.max}` : `${c.field} = ${c.values.join(" / ")}`)).join(" · ")}`
      : "Recibirá las fichas que no encajen en ninguna otra ruta (comodín).";

    try {
      await ctx.services.sendMessage(jid, {
        text: `📥 *Ruta «${route.name}» guardada.*\n${detalle}`,
      });
    } catch (err) {
      return `⚠️ Guardé la ruta, pero no pude escribir en este grupo: ${err?.message || err}`;
    }

    const total = typeof store.routes === "function" ? store.routes().length : routes.length;
    return [
      `✅ Ruta *${route.name}* activa en *${nombreGrupo}* (${total} en total).`,
      scope ? "" : "_Este grupo no está en una comunidad: la ruta vale para todas las fichas._",
      `Míralas con *!rutas ver*.`,
    ].filter(Boolean).join("\n");
  }

  return "Uso: *!rutas ver*, *!rutas aqui [nombre] [condiciones]*, *!rutas quitar <grupo>* o *!rutas limpiar*.";
}

async function safeGroupMetadata(ctx) {
  try {
    return (await ctx.getGroupMetadata?.()) || null;
  } catch {
    return null;
  }
}

// El creador siempre manda; si no, hace falta ser admin del grupo.
async function getAdmin(ctx, ownerPolicy) {
  const metadata = await safeGroupMetadata(ctx);
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
