import { test } from "node:test";
import assert from "node:assert";
import { normalizeNvidia } from "../src/infrastructure/nsfw/nsfwProvider.js";

test("normalizeNvidia: User Safety safe -> score 0", () => {
  const r = normalizeNvidia("User Safety: safe");
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.provider, "nvidia");
});

test("normalizeNvidia: User Safety unsafe -> score 1", () => {
  const r = normalizeNvidia("User Safety: unsafe");
  assert.strictEqual(r.score, 1);
});

test("normalizeNvidia: unsafe con categorías sexuales -> score 1 y reason con categorías", () => {
  const r = normalizeNvidia("User Safety: unsafe\nSafety Categories: 1(Sexual Content), 4(Explicit Content)");
  assert.strictEqual(r.score, 1);
  assert.ok(/sexual/i.test(r.reason));
});

test("normalizeNvidia: safe pero categoría de riesgo -> score 0.9", () => {
  const r = normalizeNvidia("User Safety: safe\nSafety Categories: 2(Violence)");
  assert.strictEqual(r.score, 0.9);
});

test("normalizeNvidia: Llama Guard 'safe' -> score 0", () => {
  assert.strictEqual(normalizeNvidia("safe").score, 0);
});

test("normalizeNvidia: Llama Guard 'unsafe' con códigos -> score 1", () => {
  const r = normalizeNvidia("unsafe\nS2,S3");
  assert.strictEqual(r.score, 1);
  assert.ok(/S2/.test(r.reason));
});

test("normalizeNvidia: respuesta vacía/inesperada -> score 0", () => {
  assert.strictEqual(normalizeNvidia("").score, 0);
  assert.strictEqual(normalizeNvidia("sin formato esperado").score, 0);
});
