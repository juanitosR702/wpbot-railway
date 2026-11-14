import { test } from "node:test";
import assert from "node:assert";
import {
  isBotCheck,
  needsProgressiveFallback,
  extractorVariants,
  describeYtDlpError,
  looksLikeMp3,
} from "../src/infrastructure/youtube/downloader.js";

const botCheckError = () => {
  const err = new Error("Command failed: yt-dlp --output - URL");
  err.stderr = "ERROR: [youtube] T_FkEw27XJ0: Sign in to confirm you’re not a bot. Use --cookies for the authentication.";
  return err;
};

test("isBotCheck: detecta el chequeo anti-bot de YouTube", () => {
  assert.strictEqual(isBotCheck(botCheckError()), true);
});

test("isBotCheck: no confunde otros errores", () => {
  const err = new Error("Command failed");
  err.stderr = "ERROR: [youtube] xyz: Private video. Sign in if you've been granted access";
  assert.strictEqual(isBotCheck(err), false);
  assert.strictEqual(isBotCheck(new Error("maxBuffer length exceeded")), false);
});

test("extractorVariants: sin configuración usa los clientes de respaldo", () => {
  const variants = extractorVariants("");
  assert.ok(variants.length >= 2);
  assert.ok(variants.every((v) => v.startsWith("youtube:player_client=")));
});

test("extractorVariants: el cliente configurado va primero y no se duplica", () => {
  const configured = "youtube:player_client=tv_simply,web_embedded";
  const variants = extractorVariants(configured);
  assert.strictEqual(variants[0], configured);
  assert.strictEqual(variants.filter((v) => v === configured).length, 1);
});

test("describeYtDlpError: bot check indica cargar cookies al admin", () => {
  const message = describeYtDlpError(botCheckError());
  assert.match(message, /cookies/i);
  assert.match(message, /YTDLP_COOKIES_B64/);
});

test("describeYtDlpError: maxBuffer se traduce a un mensaje legible", () => {
  const err = new Error("stdout maxBuffer length exceeded");
  assert.match(describeYtDlpError(err), /demasiado largo/i);
});

test("needsProgressiveFallback: detecta el 403 del audio DASH", () => {
  const err = new Error("Command failed");
  err.stderr = "ERROR: unable to download video data: HTTP Error 403: Forbidden";
  assert.strictEqual(needsProgressiveFallback(err), true);
});

test("needsProgressiveFallback: no se activa por bot check ni por video privado", () => {
  assert.strictEqual(needsProgressiveFallback(botCheckError()), false);
  const priv = new Error("Command failed");
  priv.stderr = "ERROR: [youtube] x: Private video";
  assert.strictEqual(needsProgressiveFallback(priv), false);
});

test("looksLikeMp3: reconoce ID3 y frames, rechaza webm", () => {
  assert.strictEqual(looksLikeMp3(Buffer.from([0x49, 0x44, 0x33, 0x04])), true);
  assert.strictEqual(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00])), true);
  assert.strictEqual(looksLikeMp3(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), false);
  assert.strictEqual(looksLikeMp3(Buffer.alloc(0)), false);
});
