// Reparto de fichas a varios grupos según los datos del formulario.
//
// Una ruta es `{ id, name, jid, conditions, enabled }`. Cada condición es
// `{ field, type: "range", min, max }` o `{ field, type: "values", values }`.
// Un ruta SIN condiciones es comodín: recibe lo que no encaje en ninguna otra.
//
// Todo este archivo es puro (sin Mongo ni WhatsApp) para poder testearlo.

export function normalizeRouteText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convierte un token en condición.
 *   `edad=13-17`            -> rango 13..17 sobre el campo "Edad"
 *   `pais=colombia|mexico`  -> valores permitidos
 *   `13-17`                 -> rango sobre "Edad" (atajo)
 * Devuelve null si no se entiende (el plugin avisa al admin).
 */
export function parseRouteCondition(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;

  const eq = raw.indexOf("=");
  let field;
  let rawValue;

  if (eq === -1) {
    if (!/^\d{1,3}\s*-\s*\d{1,3}$/.test(raw)) return null;
    field = "Edad";
    rawValue = raw;
  } else {
    field = raw.slice(0, eq).trim();
    rawValue = raw.slice(eq + 1).trim();
  }
  if (!field || !rawValue) return null;

  const range = rawValue.match(/^(\d{1,3})\s*-\s*(\d{1,3})$/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
    return { field, type: "range", min, max };
  }

  const values = rawValue.split(/[|,;]/).map((value) => value.trim()).filter(Boolean);
  if (!values.length) return null;
  return { field, type: "values", values };
}

function fieldValue(form, values, key) {
  const target = normalizeRouteText(key);
  if (!target) return "";
  const fields = form?.fields || [];
  const index = fields.findIndex((field) => {
    const label = normalizeRouteText(field?.label);
    return label && (label === target || label.includes(target));
  });
  if (index === -1) return "";
  const value = values?.[index];
  return value === undefined || value === null ? "" : String(value).trim();
}

function conditionMatches(condition, form, values) {
  const value = fieldValue(form, values, condition.field);
  if (!value) return false;

  if (condition.type === "range") {
    const digits = value.replace(/[^\d]/g, "");
    if (!digits) return false;
    const number = Number(digits);
    return Number.isFinite(number) && number >= condition.min && number <= condition.max;
  }

  const allowed = (condition.values || []).map(normalizeRouteText);
  return allowed.includes(normalizeRouteText(value));
}

/** true solo si la ruta tiene condiciones y todas se cumplen. */
export function routeMatches(route, form, values) {
  const conditions = route?.conditions || [];
  if (!conditions.length) return false;
  return conditions.every((condition) => conditionMatches(condition, form, values));
}

/**
 * Decide a qué grupos va la ficha.
 * Primero, todos los que cumplan sus condiciones; si ninguno coincide, los
 * comodines (rutas sin condiciones). Los JID repetidos se envían una sola vez.
 */
export function resolveFichaTargets(routes, form, values) {
  const active = (routes || []).filter((route) => route?.jid && route.enabled !== false);
  const conditional = active.filter((route) => (route.conditions || []).length);
  const wildcards = active.filter((route) => !(route.conditions || []).length);

  const matched = conditional.filter((route) => routeMatches(route, form, values));
  const chosen = matched.length ? matched : wildcards;

  const seen = new Set();
  const sends = [];
  for (const route of chosen) {
    if (seen.has(route.jid)) continue;
    seen.add(route.jid);
    sends.push({ jid: route.jid, name: route.name || "" });
  }

  return {
    sends,
    matched: matched.length,
    fallback: matched.length === 0 && wildcards.length > 0,
  };
}

/** Texto legible de una condición (para `!rutas ver`). */
export function describeCondition(condition) {
  if (condition?.type === "range") return `${condition.field}: ${condition.min}–${condition.max}`;
  if (condition?.type === "values") return `${condition.field}: ${(condition.values || []).join(" / ")}`;
  return "?";
}

/** Listado de rutas configuradas. */
export function renderRoutes(routes) {
  const list = routes || [];
  if (!list.length) {
    return [
      "📥 *Rutas de fichas*",
      "",
      "No hay ninguna. Añade este grupo con:",
      "• *!rutas aqui <nombre>* — recibe las que no encajen en otra ruta",
      "• *!rutas aqui <nombre> edad=13-17* — solo ese rango de edad",
      "• *!rutas aqui <nombre> pais=colombia|mexico* — solo esos valores",
    ].join("\n");
  }

  const lines = ["📥 *Rutas de fichas*", ""];
  list.forEach((route, index) => {
    const conditions = route.conditions || [];
    const detalle = conditions.length
      ? conditions.map(describeCondition).join(" · ")
      : "comodín (recibe las que no encajen)";
    const estado = route.enabled === false ? " ⏸" : "";
    lines.push(`${index + 1}. *${route.name || "sin nombre"}*${estado} — ${detalle}`);
    lines.push(`   ${route.jid}`);
  });
  lines.push("", "La ficha se manda a *todos* los grupos cuyas condiciones se cumplan.");
  return lines.join("\n");
}
