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
 *   `edad<16` / `edad>=16`  -> comparación (se guarda como rango)
 *   `pais=colombia|mexico`  -> valores permitidos
 *   `13-17`                 -> rango sobre "Edad" (atajo)
 * Devuelve null si no se entiende (el plugin avisa al admin).
 */
export function parseRouteCondition(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;

  // Comparaciones: `edad<16`, `edad>=16`, `edad<=15`, `edad>17`.
  const comparison = raw.match(/^(.+?)\s*(<=|>=|<|>)\s*(\d{1,3})$/);
  if (comparison) {
    const field = comparison[1].trim();
    const operator = comparison[2];
    const number = Number(comparison[3]);
    if (!field || !Number.isFinite(number)) return null;
    const MIN_AGE = 0;
    const MAX_AGE = 999;
    if (operator === "<") return { field, type: "range", min: MIN_AGE, max: number - 1 };
    if (operator === "<=") return { field, type: "range", min: MIN_AGE, max: number };
    if (operator === ">") return { field, type: "range", min: number + 1, max: MAX_AGE };
    return { field, type: "range", min: number, max: MAX_AGE };
  }

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
export function resolveFichaTargets(routes, form, values, { scope = "" } = {}) {
  // Rutas cerradas: una ruta solo vale dentro de su misma comunidad. Sin
  // comunidad (ni en la ruta ni en la ficha) no hay coincidencia posible, así
  // que ninguna ficha puede saltar de comunidad ni llegar a una ruta huérfana.
  const active = (routes || []).filter((route) => (
    Boolean(route?.jid)
    && route.enabled !== false
    && Boolean(route.scope)
    && Boolean(scope)
    && route.scope === scope
  ));
  const conditional = active.filter((route) => (route.conditions || []).length);
  const wildcards = active.filter((route) => !(route.conditions || []).length);

  const matched = conditional.filter((route) => routeMatches(route, form, values));
  const chosen = matched.length ? matched : wildcards;

  const seen = new Set();
  const sends = [];
  for (const route of chosen) {
    if (seen.has(route.jid)) continue;
    seen.add(route.jid);
    sends.push({ jid: route.jid, name: route.name || "", invite: route.invite || "" });
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
export function renderRoutes(routes, { names = {}, communities = {}, origin = null } = {}) {
  const list = routes || [];
  if (!list.length) {
    return [
      "📥 *Rutas de fichas*",
      "",
      "No hay ninguna. Añade este grupo con:",
      "• *!rutas agregar* — asistente: eliges grupos por número y pones la condición",
      "• *!rutas aqui* — este mismo grupo, con la condición que escribas",
      "• Condiciones: *edad<16*, *edad=13-17*, *pais=colombia|mexico*",
      "• Sin condición = comodín (recibe a quien no encaje en otra ruta)",
    ].join("\n");
  }

  // Se agrupa por condición: así se ve de un vistazo que una misma regla
  // (edad<16, por ejemplo) alimenta varios grupos.
  const groups = new Map();
  for (const route of list) {
    const conditions = route.conditions || [];
    const key = conditions.length ? conditions.map(describeCondition).join(" · ") : "comodín";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(route);
  }

  const lines = ["📥 *Rutas de fichas*", ""];
  for (const [condition, items] of groups) {
    lines.push(`🔹 *${condition}* — ${items.length} grupo${items.length > 1 ? "s" : ""}`);
    for (const route of items) {
      const nombreGrupo = names[route.jid] || "";
      const estado = route.enabled === false ? " ⏸" : "";
      const link = /^https?:/i.test(String(route.invite || "")) ? "link fijo" : "link automático";
      lines.push(`   • *${route.name || nombreGrupo || "sin nombre"}*${estado}`);
      if (nombreGrupo && route.name && normalizeRouteText(nombreGrupo) !== normalizeRouteText(route.name)) {
        lines.push(`     🏷 ${nombreGrupo}`);
      }
      if (!nombreGrupo) lines.push(`     🏷 ${route.jid}`);
      if (route.scope && route.scope !== route.jid) {
        const comunidad = communities[route.scope];
        lines.push(`     🏘 ${comunidad ? `Comunidad: ${comunidad}` : route.scope}`);
      }
      lines.push(`     🔗 ${link}`);
    }
    lines.push("");
  }

  lines.push("", "La ficha se publica en el grupo de almacén y el bot añade a la persona");
  lines.push("a todos los grupos de *su misma comunidad* cuyas condiciones se cumplan.");

  if (origin?.jid) {
    lines.push("", "─────", `📍 Este grupo: ${origin.name || origin.jid}`);
    if (!origin.scope) {
      lines.push("🏘 Comunidad: ninguna (grupo suelto)");
    } else {
      const comunidad = communities[origin.scope];
      lines.push(`🏘 Comunidad: ${comunidad || origin.scope}`);
    }
    const scopes = [...new Set(list.map((route) => route.scope || ""))];
    const ajenas = scopes.filter((scope) => scope && scope !== origin.scope);
    if (ajenas.length) {
      lines.push("⚠️ Hay rutas de otra comunidad: desde aquí no se aplicarían.");
    }
  }

  return lines.join("\n");
}

/**
 * ¿Se puede aprobar una solicitud de entrada a `groupId`? Solo si ese grupo es
 * destino de una ruta activa y la persona ya llenó la ficha y quedó incluida
 * en él. Es puro: el plugin no decide permisos, solo compara datos guardados.
 */
export function canApproveJoin(routes, groupId, member) {
  if (!groupId || !member) return false;
  const route = (routes || []).find((item) => item?.jid === groupId && item?.enabled !== false);
  if (!route) return false;
  return (member.groups || []).includes(groupId);
}
