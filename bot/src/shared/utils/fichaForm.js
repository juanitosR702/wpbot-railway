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

// Ficha completa pegada de una sola vez (lo que hace la IA o un admin que ya
// tiene el texto). Bloques reconocidos, en cualquier orden:
//
//   ENCABEZADO: 🐉 FICHA DE INGRESO      -> todo hasta el siguiente bloque
//   CAMPOS
//   # DATOS DEL INTEGRANTE
//   Nombre o apodo
//   País | Colombia, México, Perú
//   PIE: Gracias por tu interés.
//
// El encabezado (y `CAMPOS`/`PIE`) valen con o sin dos puntos y con o sin
// corchetes. Lo que va antes de `CAMPOS` es el título, así que también sirve
// pegar la ficha tal cual, sin marcadores de encabezado. Sin ningún marcador,
// todo se interpreta como campos. Devuelve `{ header, footer, fields }` o lanza
// Error con un mensaje claro.
const FICHA_MARKERS = {
  encabezado: "header",
  titulo: "header",
  header: "header",
  cabecera: "header",
  campos: "fields",
  fields: "fields",
  pie: "footer",
  footer: "footer",
};

// "ENCABEZADO:", "[ENCABEZADO]", "Campos" o "PIE: texto" → clave de bloque.
// Se compara sin acentos y sin importar mayúsculas.
function fichaMarker(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;

  const bracket = trimmed.match(/^\[([^\]]+)\]\s*[:.-]?\s*([\s\S]*)$/);
  if (bracket) {
    const key = markerKey(bracket[1]);
    if (key) return { key, inline: bracket[2].trim() };
  }

  const colon = trimmed.match(/^([^:]{1,24}?)\s*:\s*([\s\S]*)$/);
  if (colon) {
    const key = markerKey(colon[1]);
    if (key) return { key, inline: colon[2].trim() };
  }

  // Línea que es exactamente el marcador ("CAMPOS", "Pie").
  const key = markerKey(trimmed);
  if (key) return { key, inline: "" };

  // Marcador EN MAYÚSCULAS con el texto pegado ("CAMPOS Nombre Edad").
  const bare = trimmed.match(/^([\p{L}]{3,12})\s+([\s\S]*)$/u);
  if (bare && bare[1] === bare[1].toUpperCase()) {
    const inlineKey = markerKey(bare[1]);
    if (inlineKey) return { key: inlineKey, inline: bare[2].trim() };
  }

  return null;
}

function markerKey(value) {
  const name = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return FICHA_MARKERS[name] || null;
}

export function parseFichaText(text) {
  const WORD = "encabezado|titulo|t[íi]tulo|header|cabecera|campos|fields|pie|footer";
  // Marcadores pegados al texto: "… CAMPOS Nombre" o "… PIE: gracias". Solo se
  // parten los que van EN MAYÚSCULAS, para no romper etiquetas como "Pie de foto".
  const inline = new RegExp(`\\s+(?=(?:ENCABEZADO|TITULO|T[ÍI]TULO|HEADER|CABECERA|CAMPOS|FIELDS|PIE|FOOTER)(?:\\s*:|\\s|$))`, "g");
  const withColon = new RegExp(`\\s+(?=(?:${WORD})\\s*:)`, "gi");

  const normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(withColon, "\n")
    .replace(inline, "\n");

  const blocks = { header: [], fields: [], footer: [] };
  const preamble = [];
  let current = "preamble";
  let sawFields = false;

  for (const line of normalized.split("\n")) {
    const marker = fichaMarker(line);
    if (marker) {
      current = marker.key;
      if (marker.key === "fields") sawFields = true;
      if (marker.inline) blocks[current].push(marker.inline);
      continue;
    }
    if (current === "preamble") preamble.push(line);
    else blocks[current].push(line);
  }

  // Lo que va antes del primer marcador: si hay CAMPOS es el título de la
  // ficha; si no hay marcadores, todo el texto son campos.
  const headerLines = sawFields ? [...preamble, ...blocks.header] : blocks.header;
  const fieldsText = sawFields
    ? blocks.fields.join("\n")
    : [...preamble, ...blocks.fields].join("\n");

  return {
    header: headerLines.join("\n").trim(),
    footer: blocks.footer.join("\n").trim(),
    fields: parseFieldLines(fieldsText),
  };
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

function normalizeValue(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// Campos tipo "¿Aceptas las reglas?" o "compromiso": no vale responder que no.
function isAcceptanceField(label) {
  return /acept|reglas|compromiso|acuerdo/i.test(String(label || ""));
}

/**
 * Validación de la ficha completa antes de enviarla al grupo de almacenamiento.
 *
 * El llenado ya restringe las opciones, pero esto cubre lo que sí puede llegar
 * mal: edad fuera de rango, textos vacíos/cortos y un "No" en los campos de
 * aceptación. Devuelve los errores con el índice real del campo para volver a
 * preguntar solo esos.
 */
export function validateFichaValues(form, values = {}) {
  const errors = [];

  (form?.fields || []).forEach((field, index) => {
    if (!field?.label) return;
    const label = field.label;
    const raw = values[index];
    const value = raw === undefined || raw === null ? "" : String(raw).trim();

    if (!value) {
      errors.push({ index, message: `«${label}» no puede quedar vacío.` });
      return;
    }

    if (field.options?.length) {
      const match = field.options.find((option) => option === value)
        || field.options.find((option) => normalizeValue(option) === normalizeValue(value));
      if (!match) {
        errors.push({ index, message: `«${label}» debe ser una de las opciones.` });
        return;
      }
      if (isAcceptanceField(label) && normalizeValue(match).startsWith("no")) {
        errors.push({ index, message: `«${label}» debe responderse que sí para continuar.` });
      }
      return;
    }

    // La edad se revisa antes que el largo mínimo: "9" es un valor de un solo
    // carácter y el mensaje útil es el del rango, no "demasiado corto".
    if (/edad/i.test(label)) {
      const age = Number(value.replace(/[^\d]/g, ""));
      if (!Number.isFinite(age) || age < 13 || age > 99) {
        errors.push({ index, message: `«${label}» debe ser un número entre 13 y 99.` });
      }
      return;
    }
    if (value.length < 2) {
      errors.push({ index, message: `«${label}» es demasiado corto.` });
      return;
    }
    if (value.length > 400) {
      errors.push({ index, message: `«${label}» pasa de 400 caracteres.` });
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    firstIndex: errors.length ? errors[0].index : null,
  };
}

/** Recorta títulos de fila al límite de WhatsApp. */
export function rowTitle(value, max = 24) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
