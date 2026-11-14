import { HALT } from "../../bot/router.js";
import { MSG } from "../../../shared/messages.js";
import { jidUser, findParticipant, isAdminParticipant } from "../../../shared/utils/jid.js";
import {
  DEFAULT_FICHA,
  FICHA_PRESETS,
  MAX_LIST_OPTIONS,
  formatFichaDate,
  formSteps,
  parseFieldLines,
  renderFicha,
  renderFormConfig,
  rowTitle,
} from "../../../shared/utils/fichaForm.js";

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
      return null;
    }, {
      commands: ["ficha", "setficha", "fichadestino"],
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
  if (session.phase === "preview") return handlePreview(ctx, store, session, text, selection);
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
    // Las opciones van también en el texto: si WhatsApp no renderiza la lista
    // (o el usuario no la ve), puede responder con el número.
    const numbered = field.options
      .map((option, index) => `${index + 1}. ${option}`)
      .join("\n");

    await sendList(ctx, {
      text: `📝 *Ficha (${progress})*\n\n${field.label}\n\n${numbered}`,
      footer: "Toca «Ver opciones» o responde con el número. Escribe *cancelar* para salir.",
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

async function handlePreview(ctx, store, session, text, selection) {
  const word = normalize(text);
  const pick = selection === "f:s" || word === "1"
    ? "send"
    : selection === "f:e" || word === "2"
      ? "edit"
      : selection === "f:x" || word === "3"
        ? "cancel"
        : null;

  if (pick === "send" || (!pick && /^(enviar|si|confirmar|listo|ok)$/.test(word))) {
    return submitFicha(ctx, store, session);
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

async function submitFicha(ctx, store, session) {
  const destination = store.destination();
  if (!destination) {
    return "⚠️ No hay grupo de almacenamiento configurado. Un admin debe ejecutar *!fichadestino* en ese grupo.";
  }

  const metadata = await safeGroupMetadata(ctx);
  const text = renderFicha(session.form, session.values, {
    senderNumber: jidUser(ctx.sender),
    senderName: ctx.name && ctx.name !== ctx.sender ? ctx.name : "",
    groupName: metadata?.subject || "",
    date: formatFichaDate(),
  });

  try {
    await ctx.services.sendMessage(destination, { text, mentions: [ctx.sender] });
  } catch (err) {
    console.error("[ficha] no se pudo enviar al grupo destino:", err?.message || err);
    return "⚠️ No pude enviar la ficha al grupo de almacenamiento. Avisa a un admin.";
  }

  dropSession(ctx, session);
  return "✅ *Ficha enviada* al grupo de almacenamiento. ¡Gracias!";
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

  const lines = rows.map((row, index) => `${index + 1}. ${row.title}`).join("\n");
  return ctx.sendMessage({ text: `${text}\n\n${lines}\n\n_Responde con el número._` });
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
    return `⚙️ *Ficha de este grupo*${note}\n\n${renderFormConfig(form)}`;
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
    return destination
      ? `📥 Las fichas se guardan en: ${destination}`
      : "⚠️ No hay grupo de almacenamiento configurado.";
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
  const destination = explicit ? `${explicit}@g.us` : `${ctx.phone}@g.us`;

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
