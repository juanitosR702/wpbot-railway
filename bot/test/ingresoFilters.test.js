import { test } from "node:test";
import assert from "node:assert";

import {
  DEFAULT_EXCUSES,
  fieldValue,
  nameInitials,
  parseAge,
  pickExcuse,
  renderFilters,
  reviewFicha,
} from "../src/shared/utils/ingresoFilters.js";

const FORM = {
  header: "FICHA",
  footer: "",
  fields: [
    { section: "DATOS" },
    { label: "Nombre o apodo", options: [] },
    { label: "Edad", options: [] },
    { label: "País", options: [] },
  ],
};

const VALUES = { 1: "Ana María", 2: "17", 3: "México" };

test("filtros: sin filtros activos todo pasa", () => {
  const verdict = reviewFicha(FORM, VALUES, {});
  assert.deepStrictEqual(verdict, { ok: true, reasons: [], warnings: [] });
});

test("filtros: la edad mínima rechaza a quien no llega", () => {
  const verdict = reviewFicha(FORM, VALUES, { minAge: 18 });
  assert.strictEqual(verdict.ok, false);
  assert.deepStrictEqual(verdict.reasons, ["edad"]);
});

test("filtros: la edad se lee aunque venga con texto", () => {
  assert.strictEqual(parseAge("tengo 20 años"), 20);
  assert.strictEqual(parseAge("18-20"), 18);
  assert.strictEqual(parseAge("no digo"), null);

  const verdict = reviewFicha(FORM, { ...VALUES, 2: "tengo 20 años" }, { minAge: 18 });
  assert.strictEqual(verdict.ok, true);
});

test("filtros: edad ilegible no pasa (no se puede verificar)", () => {
  const verdict = reviewFicha(FORM, { ...VALUES, 2: "muchos" }, { minAge: 18 });
  assert.deepStrictEqual(verdict.reasons, ["edad ilegible"]);
});

test("filtros: país permitido se compara sin acentos ni mayúsculas", () => {
  const ok = reviewFicha(FORM, { ...VALUES, 3: "mexico" }, { countries: ["Colombia", "México"] });
  assert.strictEqual(ok.ok, true);

  const bad = reviewFicha(FORM, { ...VALUES, 3: "Perú" }, { countries: ["Colombia", "México"] });
  assert.deepStrictEqual(bad.reasons, ["país"]);
});

test("filtros: las iniciales se sacan de cada palabra del nombre", () => {
  assert.strictEqual(nameInitials("Ana María"), "am");
  assert.strictEqual(nameInitials("  José   Luis  "), "jl");

  const ok = reviewFicha(FORM, VALUES, { initials: ["a"] });
  assert.strictEqual(ok.ok, true);

  const bad = reviewFicha(FORM, VALUES, { initials: ["z"] });
  assert.deepStrictEqual(bad.reasons, ["iniciales"]);
});

test("filtros: varios filtros se acumulan", () => {
  const verdict = reviewFicha(FORM, VALUES, {
    minAge: 18,
    countries: ["Colombia"],
    initials: ["z"],
  });

  assert.strictEqual(verdict.ok, false);
  assert.deepStrictEqual(verdict.reasons, ["edad", "país", "iniciales"]);
});

test("filtros: un filtro sin su campo avisa y no bloquea a todos", () => {
  const sinEdad = {
    fields: [
      { label: "Nombre o apodo", options: [] },
      { label: "País", options: [] },
    ],
  };

  const verdict = reviewFicha(sinEdad, { 1: "Ana", 2: "México" }, { minAge: 18 });

  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0], /Edad/);
});

test("filtros: fieldValue ignora secciones y campos vacíos", () => {
  assert.strictEqual(fieldValue(FORM, VALUES, ["edad"]), "17");
  assert.strictEqual(fieldValue(FORM, { ...VALUES, 2: "  " }, ["edad"]), "");
});

test("filtros: la excusa propia gana y la de por defecto es estable", () => {
  assert.strictEqual(pickExcuse("Estamos llenos."), "Estamos llenos.");

  const first = pickExcuse("", "573001112233");
  assert.strictEqual(first, pickExcuse("", "573001112233"));
  assert.ok(DEFAULT_EXCUSES.includes(first));
  // No delata el motivo real.
  assert.ok(!/edad|país|inicial/i.test(first));
});

test("filtros: resumen legible para el admin", () => {
  assert.strictEqual(renderFilters({}), "sin filtros");
  assert.match(
    renderFilters({ minAge: 18, countries: ["Colombia"], initials: ["a"] }),
    /edad ≥ 18.*Colombia.*A/,
  );
});
