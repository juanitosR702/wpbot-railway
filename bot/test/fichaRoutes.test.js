import { test } from "node:test";
import assert from "node:assert";
import {
  parseRouteCondition,
  routeMatches,
  resolveFichaTargets,
  renderRoutes,
} from "../src/shared/utils/fichaRoutes.js";

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
    { name: "teens", jid: "1@g.us", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
    { name: "colombia", jid: "2@g.us", conditions: [{ field: "pais", type: "values", values: ["Colombia"] }] },
    { name: "adultos", jid: "3@g.us", conditions: [{ field: "Edad", type: "range", min: 18, max: 99 }] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES);
  assert.deepStrictEqual(result.sends.map((s) => s.jid), ["1@g.us", "2@g.us"]);
  assert.strictEqual(result.fallback, false);
});

test("resolveFichaTargets: usa los comodines cuando nada encaja", () => {
  const routes = [
    { name: "adultos", jid: "3@g.us", conditions: [{ field: "Edad", type: "range", min: 18, max: 99 }] },
    { name: "otros", jid: "9@g.us", conditions: [] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES);
  assert.deepStrictEqual(result.sends.map((s) => s.jid), ["9@g.us"]);
  assert.strictEqual(result.fallback, true);
});

test("resolveFichaTargets: no repite el mismo grupo", () => {
  const routes = [
    { name: "a", jid: "5@g.us", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
    { name: "b", jid: "5@g.us", conditions: [{ field: "pais", type: "values", values: ["Colombia"] }] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES);
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

test("resolveFichaTargets: una ficha sin comunidad no entra en rutas de comunidad", () => {
  const routes = [
    { name: "comunidad", jid: "1@g.us", scope: "comunidadA", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
    { name: "global", jid: "2@g.us", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] },
  ];
  const result = resolveFichaTargets(routes, FORM, VALUES, { scope: "" });
  assert.deepStrictEqual(result.sends.map((s) => s.jid), ["2@g.us"]);
});

test("resolveFichaTargets: las rutas antiguas sin scope siguen valiendo", () => {
  const routes = [{ name: "vieja", jid: "7@g.us", conditions: [{ field: "Edad", type: "range", min: 13, max: 17 }] }];
  const result = resolveFichaTargets(routes, FORM, VALUES, { scope: "comunidadA" });
  assert.deepStrictEqual(result.sends.map((s) => s.jid), ["7@g.us"]);
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
  assert.match(texto, /nombre no disponible/);
  const conOrigen = renderRoutes(
    [{ name: "t", jid: "1@g.us", scope: "comunidadA", conditions: [] }],
    { origin: { jid: "9@g.us", scope: "" } },
  );
  assert.match(conOrigen, /ninguna \(grupo suelto\)/);
  assert.match(conOrigen, /otra comunidad/);
  assert.match(renderRoutes([{ name: "t", jid: "1@g.us", conditions: [] }], { names: { "1@g.us": "Clan Teens" } }), /Clan Teens/);
});
