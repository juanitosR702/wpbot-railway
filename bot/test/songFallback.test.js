import { test } from "node:test";
import assert from "node:assert";
import { isBotCheck, extractorVariants, describeYtDlpError } from "../src/infrastructure/youtube/downloader.js";

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
