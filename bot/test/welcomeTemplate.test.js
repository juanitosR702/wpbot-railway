import { test } from "node:test";
import assert from "node:assert";

import { renderWelcomeTemplate } from "../src/shared/utils/welcomeTemplate.js";

const vars = { user: "@573001112233", group: "Los Panas", count: 42 };

test("welcome: @user etiqueta al usuario", () => {
  assert.strictEqual(renderWelcomeTemplate("Bienvenido @user 🎉", vars), "Bienvenido @573001112233 🎉");
});

test("welcome: {user} sigue funcionando", () => {
  assert.strictEqual(renderWelcomeTemplate("Hola {user}", vars), "Hola @573001112233");
});

test("welcome: variables sin distinguir mayusculas", () => {
  assert.strictEqual(renderWelcomeTemplate("@User en @Group", vars), "@573001112233 en Los Panas");
});

test("welcome: @usuario no se confunde con @user", () => {
  assert.strictEqual(renderWelcomeTemplate("@usuario hola", vars), "@usuario hola");
});

test("welcome: grupo, total y count", () => {
  assert.strictEqual(
    renderWelcomeTemplate("Bienvenido @user a {group}. Somos {count} ({total})", vars),
    "Bienvenido @573001112233 a Los Panas. Somos 42 (42)",
  );
});

test("welcome: un nombre con $& no rompe el reemplazo", () => {
  assert.strictEqual(
    renderWelcomeTemplate("Hola @user de {group}", { user: "@123", group: "A$&B" }),
    "Hola @123 de A$&B",
  );
});

test("welcome: texto plano queda intacto", () => {
  assert.strictEqual(renderWelcomeTemplate("Solo un saludo", vars), "Solo un saludo");
});
