// Filtros de ingreso sobre la ficha terminada.
//
// Se aplican solo en el Lobby y solo si el flujo de ingreso está activo. La
// persona no ve el motivo real: recibe una excusa creíble (cupo lleno, lista de
// espera) para que no pueda adaptar sus respuestas y volver a intentarlo.
//
// Todo aquí es puro (sin Mongo ni WhatsApp) para poder testearlo.

const AGE_PATTERNS = ["edad", "anos"];
const COUNTRY_PATTERNS = ["pais", "nacionalidad"];
const NAME_PATTERNS = ["nombre", "apodo"];

export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Primer valor no vacío cuya etiqueta contenga alguno de los patrones. */
export function fieldValue(form, values, patterns) {
  const fields = form?.fields || [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.section || !field.label) continue;
    const label = normalize(field.label);
    if (!patterns.some((pattern) => label.includes(pattern))) continue;

    const raw = values?.[index];
    const text = raw === undefined || raw === null ? "" : String(raw).trim();
    if (text) return text;
  }

  return "";
}

/** Edad numérica de un texto libre ("18", "tengo 18 años", "18-20"). */
export function parseAge(value) {
  const match = String(value || "").match(/\d{1,3}/);
  if (!match) return null;
  const age = Number(match[0]);
  return Number.isInteger(age) && age > 0 && age < 120 ? age : null;
}

/** Iniciales de cada palabra: "Ana María" -> "am". */
export function nameInitials(value) {
  return normalize(value)
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .map((word) => word[0])
    .join("");
}

/**
 * Revisa la ficha contra los filtros configurados.
 * Devuelve `{ ok, reasons, warnings }`:
 *   - `reasons`: filtros que no se cumplen (motivo del rechazo).
 *   - `warnings`: filtros activos sin campo en la ficha (no se pueden evaluar).
 * Un filtro activo cuyo campo no existe NO rechaza: se avisa para que un admin
 * arregle la ficha, en vez de bloquear a todo el mundo.
 */
export function reviewFicha(form, values, filters = {}) {
  const minAge = Number(filters.minAge) || 0;
  const countries = (filters.countries || []).map(normalize).filter(Boolean);
  const initials = (filters.initials || []).map(normalize).filter(Boolean);

  const reasons = [];
  const warnings = [];

  if (minAge > 0) {
    const value = fieldValue(form, values, AGE_PATTERNS);
    if (!value) {
      warnings.push(`filtro de edad sin campo "Edad" en la ficha`);
    } else {
      const age = parseAge(value);
      if (age === null) reasons.push("edad ilegible");
      else if (age < minAge) reasons.push("edad");
    }
  }

  if (countries.length) {
    const value = fieldValue(form, values, COUNTRY_PATTERNS);
    if (!value) {
      warnings.push(`filtro de país sin campo "País" en la ficha`);
    } else {
      const normalized = normalize(value);
      const allowed = countries.some((country) => normalized.includes(country));
      if (!allowed) reasons.push("país");
    }
  }

  if (initials.length) {
    const value = fieldValue(form, values, NAME_PATTERNS);
    if (!value) {
      warnings.push(`filtro de iniciales sin campo "Nombre" en la ficha`);
    } else {
      const letters = nameInitials(value);
      const allowed = initials.some((initial) => letters.includes(initial));
      if (!allowed) reasons.push("iniciales");
    }
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

// Excusas creíbles: no revelan el filtro real, así que la persona no puede
// cambiar sus datos y reintentar. Una se elige de forma estable por persona.
export const DEFAULT_EXCUSES = [
  "⏳ *Solicitud en revisión*\n\nEl grupo general está completo por ahora. En cuanto se libere un cupo te avisamos por aquí.",
  "⏳ *Lista de espera*\n\nEl clan entra por tandas y ahora mismo no hay cupo. Te escribimos por aquí cuando se abra el siguiente.",
  "⏳ *Ficha recibida*\n\nEstamos revisando las solicitudes de esta semana. Si queda un lugar, te avisamos por aquí.",
];

/** Excusa configurada o una de las de por defecto (estable por `seed`). */
export function pickExcuse(custom, seed = "") {
  const text = String(custom || "").trim();
  if (text) return text;

  let hash = 0;
  for (const char of String(seed)) {
    hash = (hash * 31 + char.charCodeAt(0)) % 100000;
  }
  return DEFAULT_EXCUSES[hash % DEFAULT_EXCUSES.length];
}

/** Resumen de una línea para `!ingreso ver` / `!ingreso filtros`. */
export function renderFilters(filters = {}) {
  const parts = [];
  const minAge = Number(filters.minAge) || 0;
  if (minAge > 0) parts.push(`edad ≥ ${minAge}`);
  if (filters.countries?.length) parts.push(`países: ${filters.countries.join(", ")}`);
  if (filters.initials?.length) parts.push(`iniciales: ${filters.initials.join(", ").toUpperCase()}`);
  return parts.length ? parts.join(" · ") : "sin filtros";
}
