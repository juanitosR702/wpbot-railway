// Modelo de una ficha configurable por grupo.
//
// Un campo es `{ label, options }` (options vacío = texto libre) o
// `{ section }` para un título de sección. Todo lo de este archivo es puro
// (sin Mongo ni WhatsApp) para poder testearlo sin dependencias.

// WhatsApp permite 10 filas por lista; una se reserva para "Cancelar".
export const MAX_LIST_OPTIONS = 9;

// Se usa cuando el grupo no configuró su propia ficha. Replica la ficha de
// ingreso típica: datos, actividad y compromiso.
export const DEFAULT_FICHA = {
  header: "✦ FICHA DE INGRESO ✦",
  footer: "🖤 Gracias por tu interés. Pronto te responderemos.",
  fields: [
    { section: "DATOS DEL INTEGRANTE" },
    { label: "Nombre o apodo", options: [] },
    { label: "Edad", options: [] },
    { label: "Usuario", options: [] },
    {
      label: "País",
      options: [
        "Colombia",
        "México",
        "Perú",
        "Argentina",
        "Chile",
        "Ecuador",
        "Venezuela",
        "Otro",
      ],
    },
    { section: "UN POCO SOBRE TI" },
    {
      label: "¿Qué tan activo/a eres?",
      options: ["Muy activo/a", "Activo/a", "A veces", "Poco activo/a"],
    },
    { label: "¿Por qué quieres entrar al clan?", options: [] },
    { section: "COMPROMISO" },
    { label: "¿Aceptas las reglas del clan?", options: ["Sí", "No"] },
  ],
};

/**
 * Fichas listas para instalar con `!setficha dragon`.
 * Se guardan como configuración del grupo, así que se pueden editar luego.
 */
export const FICHA_PRESETS = {
  dragon: {
    header: "🐉 𓆩 𝙂𝙃𝙊𝙎𝙏 𝘿𝙍𝘼𝙂𝙊𝙉𝙎 𓆪 🐉\n✦ FICHA DE INGRESO ✦",
    footer: [
      "🖤 Gracias por tu interés en formar parte de nuestro clan.",
      "🐲 *GHOST DRAGONS*",
      "Una sola unión, una sola lealtad.",
    ].join("\n"),
    fields: [
      { section: "DATOS DEL INTEGRANTE" },
      { label: "Nombre o apodo", options: [] },
      { label: "Edad", options: [] },
      { label: "Usuario", options: [] },
      {
        label: "País",
        options: [
          "Colombia",
          "México",
          "Perú",
          "Argentina",
          "Chile",
          "Ecuador",
          "Venezuela",
          "Otro",
        ],
      },
      { section: "UN POCO SOBRE TI" },
      {
        label: "¿Qué tan activo/a eres?",
        options: ["Muy activo/a", "Activo/a", "A veces", "Poco activo/a"],
      },
      { label: "¿Por qué quieres entrar al clan?", options: [] },
      { section: "COMPROMISO" },
      { label: "¿Aceptas las reglas del clan?", options: ["Sí", "No"] },
    ],
  },
};

/**
 * Convierte el bloque de texto que manda un admin en campos.
 *
 *   # DATOS DEL INTEGRANTE        -> sección
 *   Nombre o apodo                -> texto libre
 *   País | Colombia, México       -> desplegable
 *
 * Lanza Error con un mensaje claro si algo no sirve (el plugin lo responde).
 */
export function parseFieldLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  const fields = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      const section = line.replace(/^#+\s*/, "").trim();
      if (section) fields.push({ section });
      continue;
    }

    const [rawLabel, rawOptions] = splitOnce(line, "|");
    const label = rawLabel.trim();
    if (!label) continue;
    if (label.length > 80) {
      throw new Error(`«${label.slice(0, 40)}…» es demasiado largo (máx. 80 caracteres).`);
    }

    const options = parseOptions(rawOptions);
    if (options.length > MAX_LIST_OPTIONS) {
      throw new Error(`«${label}» tiene ${options.length} opciones; el máximo es ${MAX_LIST_OPTIONS}.`);
    }

    fields.push({ label, options });
  }

  if (!fields.some((field) => field.label)) {
    throw new Error("La ficha necesita al menos un campo (ej: `Nombre o apodo`).");
  }

  return fields;
}

function parseOptions(raw) {
  if (!raw) return [];
  return [...new Set(
    String(raw)
      .split(/[,;]/)
      .map((option) => option.trim())
      .filter(Boolean),
  )];
}

function splitOnce(value, separator) {
  const index = value.indexOf(separator);
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + 1)];
}

/** Campos que se le preguntan al usuario (sin secciones), con su índice real. */
export function formSteps(form) {
  return (form?.fields || [])
    .map((field, index) => ({ field, index }))
    .filter((step) => Boolean(step.field?.label));
}

/** Texto de la ficha tal como llega al grupo de almacenamiento. */
export function renderFicha(form, values = {}, meta = {}) {
  const lines = [];

  if (form?.header) lines.push(form.header, "");

  let hasSection = false;
  (form?.fields || []).forEach((field, index) => {
    if (field.section) {
      if (hasSection) lines.push("");
      hasSection = true;
      lines.push(`✦ *${field.section}*`);
      return;
    }
    const value = values[index];
    lines.push(`• ${field.label}: ${value === undefined || value === null || value === "" ? "—" : value}`);
  });

  if (form?.footer) lines.push("", form.footer);

  if (meta.senderNumber) {
    lines.push("", "────────────");
    const name = meta.senderName ? ` (${meta.senderName})` : "";
    lines.push(`👤 Enviado por: @${meta.senderNumber}${name}`);
    if (meta.groupName) lines.push(`🏷 Grupo: ${meta.groupName}`);
    if (meta.date) lines.push(`🕒 ${meta.date}`);
  }

  return lines.join("\n").trim();
}

/** Ficha en progreso: se muestra completa en cada paso (con el campo actual marcado). */
export function renderProgress(form, values = {}, currentIndex = -1) {
  const lines = [];

  if (form?.header) lines.push(form.header, "");

  (form?.fields || []).forEach((field, index) => {
    if (field.section) {
      lines.push(`✦ *${field.section}*`);
      return;
    }
    const value = values[index];
    const filled = value !== undefined && value !== null && String(value).trim() !== "";
    const mark = index === currentIndex ? "👉" : "•";
    lines.push(`${mark} ${field.label}: ${filled ? value : "…"}`);
  });

  return lines.join("\n").trim();
}

/** Resumen legible de la configuración (para `!setficha ver`). */
export function renderFormConfig(form) {
  const lines = [];
  lines.push("*Encabezado:*", form?.header || "(vacío)", "");
  lines.push("*Campos:*");
  for (const field of form?.fields || []) {
    if (field.section) {
      lines.push(`# ${field.section}`);
      continue;
    }
    lines.push(field.options?.length ? `${field.label} | ${field.options.join(", ")}` : field.label);
  }
  lines.push("", "*Pie:*", form?.footer || "(vacío)");
  return lines.join("\n");
}

/** Fecha corta en español, con la zona del servidor. */
export function formatFichaDate(date = new Date()) {
  try {
    return date.toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return date.toISOString();
  }
}

/** Recorta títulos de fila al límite de WhatsApp. */
export function rowTitle(value, max = 24) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
