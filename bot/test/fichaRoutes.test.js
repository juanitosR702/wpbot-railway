import { test } from "node:test";
import assert from "node:assert";
import { parseRouteCondition, routeMatches, resolveFichaTargets, renderRoutes, canApproveJoin } from "../src/shared/utils/fichaRoutes.js";

const FORM = {
  fields: [
    { label: "Nombre o apodo" },
    { section: "DATOS" },
    { label: "Edad" },
    { label: "País" },
  ],
};

// Los valores se guardan por índice real del campo (incluye secciones).
const VALUES = { 0: "Ana", 2: "17", 3: "Colombia" };

test("parseRouteCondition: rango de edad", () => {
  assert.deepStrictEqual(parseRouteCondition("edad=13-17"), {
    field: "edad",
    type: "range",
    min: 13,
    max: 17,
  });
});

test("parseRouteCondition: comparaciones (<, <=, >, >=)", () => {
  assert.deepStrictEqual(parseRouteCondition("edad<16"), { field: "edad", type: "range", min: 0, max: 15 });
  assert.deepStrictEqual(parseRouteCondition("edad<=16"), { field: "edad", type: "range", min: 0, max: 16 });
  assert.deepStrictEqual(parseRouteCondition("edad>16"), { field: "edad", type: "range", min: 17, max: 999 });
  assert.deepStrictEqual(parseRouteCondition("Edad >= 16"), { field: "Edad", type: "range", min: 16, max: 999 });
});

test("parseRouteCondition: rango suelto usa el campo Edad", () => {
  const condition = parseRouteCondition("18-99");
  assert.strictEqual(condition.field, "Edad");
  assert.strictEqual(condition.type, "range");
});

test("parseRouteCondition: lista de valores", () => {
  assert.deepStrictEqual(parseRouteCondition("pais=colombia|mexico"), {
    field: "pais",
    type: "values",
    values: ["colombia", "mexico"],
  });
});

test("parseRouteCondition: rechaza lo que no entiende", () => {
  assert.strictEqual(parseRouteCondition(""), null);
  assert.strictEqual(parseRouteCondition("sin-igual"), null);
  assert.strictEqual(parseRouteCondition("edad=30-20"), null);
  assert.strictEqual(parseRouteCondition("edad="), null);
});

test("routeMatches: cumple y no cumple el rango", () => {
  const teens = { conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] };
  const adults = { conditions: [{ field: "Edad", type: "range", min: 18, max: 99 }] };
  assert.strictEqual(routeMatches(teens, FORM, VALUES), true);
  assert.strictEqual(routeMatches(adults, FORM, VALUES), false);
});

test("routeMatches: valores sin importar mayúsculas ni tildes", () => {
  const route = { conditions: [{ field: "pais", type: "values", values: ["COLOMBIA"] }] };
  assert.strictEqual(routeMatches(route, FORM, VALUES), true);
  const otro = { conditions: [{ field: "pais", type: "values", values: ["Perú"] }] };
  assert.strictEqual(routeMatches(otro, FORM, VALUES), false);
});

test("routeMatches: campo inexistente o ruta sin condiciones no coincide", () => {
  const desconocido = { conditions: [{ field: "equipo", type: "values", values: ["x"] }] };
  assert.strictEqual(routeMatches(desconocido, FORM, VALUES), false);
  assert.strictEqual(routeMatches({ conditions: [] }, FORM, VALUES), false);
});

test("resolveFichaTargets: envía a todos los grupos que cumplan", () => {
  const routes = [
    { name: "teens", jid: "1@g.us", scope: "comunidadA", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
    { name: "colombia", jid: "2@g.us", scope: "comunidadA", conditions: [{ field: "pais", type: "values", values: ["Colombia"] }] },
    { name: "adultos", jid: "3@g.us", scope: "comunidadA", conditions: [{ field: "Edad", type: "range", min: 18, max: 99 }] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES, { scope: "comunidadA" });
  assert.deepStrictEqual(result.sends.map((s) => s.jid), ["1@g.us", "2@g.us"]);
  assert.strictEqual(result.fallback, false);
});

test("resolveFichaTargets: usa los comodines cuando nada encaja", () => {
  const routes = [
    { name: "adultos", jid: "3@g.us", scope: "comunidadA", conditions: [{ field: "Edad", type: "range", min: 18, max: 99 }] },
    { name: "otros", jid: "9@g.us", scope: "comunidadA", conditions: [] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES, { scope: "comunidadA" });
  assert.deepStrictEqual(result.sends.map((s) => s.jid), ["9@g.us"]);
  assert.strictEqual(result.fallback, true);
});

test("resolveFichaTargets: no repite el mismo grupo", () => {
  const routes = [
    { name: "a", jid: "5@g.us", scope: "comunidadA", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
    { name: "b", jid: "5@g.us", scope: "comunidadA", conditions: [{ field: "pais", type: "values", values: ["Colombia"] }] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES, { scope: "comunidadA" });
  assert.strictEqual(result.sends.length, 1);
});

test("resolveFichaTargets: no mezcla comunidades distintas", () => {
  const routes = [
    { name: "mía", jid: "1@g.us", scope: "comunidadA", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
    { name: "ajena", jid: "2@g.us", scope: "comunidadB", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES, { scope: "comunidadA" });
  assert.deepStrictEqual(result.sends.map((s) => s.jid), ["1@g.us"]);
});

test("resolveFichaTargets: una ficha sin comunidad no entra en ninguna ruta", () => {
  const routes = [
    { name: "comunidad", jid: "1@g.us", scope: "comunidadA", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
    { name: "suelta", jid: "2@g.us", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES, { scope: "" });
  assert.deepStrictEqual(result.sends, []);
});

test("resolveFichaTargets: las rutas sin comunidad ya no valen (cerradas)", () => {
  const routes = [{ name: "vieja", jid: "7@g.us", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] }];
  const result = resolveFichaTargets(routes, FORM, VALUES, { scope: "comunidadA" });
  assert.deepStrictEqual(result.sends, []);
});

test("resolveFichaTargets: sin rutas no hay destinos", () => {
  assert.deepStrictEqual(resolveFichaTargets([], FORM, VALUES).sends, []);
  assert.deepStrictEqual(resolveFichaTargets(undefined, FORM, VALUES).sends, []);
});

test("renderRoutes: explica cómo crear la primera ruta", () => {
  assert.match(renderRoutes([]), /!rutas aqui/);
  const texto = renderRoutes([{ name: "teens", jid: "1@g.us", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] }]);
  assert.match(texto, /teens/);
  assert.match(texto, /13–17/);
  // Sin nombre resuelto se muestra el JID, nunca un texto raro.
  assert.match(texto, /1@g\.us/);
  const conOrigen = renderRoutes(
    [{ name: "t", jid: "1@g.us", scope: "comunidadA", conditions: [] }],
    { origin: { jid: "9@g.us", scope: "" } },
  );
  assert.match(conOrigen, /ninguna \(grupo suelto\)/);
  assert.match(conOrigen, /otra comunidad/);
  assert.match(renderRoutes([{ name: "t", jid: "1@g.us", conditions: [] }], { names: { "1@g.us": "Clan Teens" } }), /Clan Teens/);

  // Con nombre de grupo, el JID deja de aparecer.
  const conNombre = renderRoutes(
    [{ name: "t", jid: "1@g.us", conditions: [] }],
    { names: { "1@g.us": "Clan Teens" } },
  );
  assert.strictEqual(conNombre.includes("1@g.us"), false);
  assert.match(conNombre, /🏷 Clan Teens/);
});

test("renderRoutes: muestra el nombre de la comunidad, no su JID", () => {
  const texto = renderRoutes(
    [{ name: "t", jid: "1@g.us", scope: "com@g.us", conditions: [] }],
    { names: { "1@g.us": "Grupo" }, communities: { "com@g.us": "Ghost Dragons" } },
  );
  assert.match(texto, /Comunidad: Ghost Dragons/);
  assert.strictEqual(texto.includes("com@g.us"), false);
});

test("renderRoutes: agrupa todos los grupos que comparten condición", () => {
  const rango = (min, max) => [{ field: "Edad", type: "range", min, max }];
  const texto = renderRoutes(
    [
      { name: "A", jid: "1@g.us", conditions: rango(16, 999) },
      { name: "B", jid: "2@g.us", conditions: rango(16, 999) },
      { name: "C", jid: "3@g.us", conditions: rango(0, 15) },
    ],
    { names: { "1@g.us": "Grupo A", "2@g.us": "Grupo B", "3@g.us": "Grupo C" } },
  );

  assert.match(texto, /\*Edad: 16–999\* — 2 grupos/);
  assert.match(texto, /\*Edad: 0–15\* — 1 grupo/);
  // Los dos grupos de la misma condición salen juntos, antes del siguiente rango.
  const a = texto.indexOf("Grupo A");
  const b = texto.indexOf("Grupo B");
  const c = texto.indexOf("Grupo C");
  assert.ok(a < b && b < c, "los grupos de 16+ deben ir juntos");
});

test("canApproveJoin: solo aprueba si la ficha incluye ese grupo de ruta", () => {
  const routes = [
    { name: "teens", jid: "1@g.us", conditions: [] },
    { name: "adultos", jid: "2@g.us", conditions: [], enabled: false },
  ];
  const member = { groups: ["1@g.us"] };

  assert.strictEqual(canApproveJoin(routes, "1@g.us", member), true);
  // No es destino de ninguna ruta.
  assert.strictEqual(canApproveJoin(routes, "9@g.us", member), false);
  // Ruta desactivada.
  assert.strictEqual(canApproveJoin(routes, "2@g.us", { groups: ["2@g.us"] }), false);
  // La ficha no lo incluyó (no cumple las condiciones).
  assert.strictEqual(canApproveJoin(routes, "1@g.us", { groups: [] }), false);
  assert.strictEqual(canApproveJoin(routes, "1@g.us", null), false);
  // Ruta comodín (sin condiciones) también vale si la ficha lo incluyó.
  assert.strictEqual(canApproveJoin([{ jid: "3@g.us", conditions: [] }], "3@g.us", { groups: ["3@g.us"] }), true);
});
