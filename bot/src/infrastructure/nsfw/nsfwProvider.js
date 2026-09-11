import { env, envNumber } from "../../shared/config/env.js";
import sharp from "sharp";
import OpenAI from "openai";

const DEFAULTS = {
  provider: "disabled",
  threshold: 0.75,
  timeoutMs: 8000,
  sightengineUrl: "https://api.sightengine.com/1.0/check.json",
  geminiApiUrl: "https://generativelanguage.googleapis.com/v1beta",
};

function scoreFromObject(value) {
  if (!value || typeof value !== "object") return 0;
  return Math.max(
    Number(value.score || 0),
    Number(value.probability || 0),
    Number(value.confidence || 0),
  );
}

function normalizeSightengine(data) {
  const nudity = data?.nudity || {};
  const scores = [
    nudity.raw,
    nudity.partial,
    nudity.sexual_activity,
    nudity.sexual_display,
    nudity.erotica,
  ].map((value) => Number(value || 0));
  return { score: Math.max(0, ...scores), details: data };
}

function normalizeNudeNet(data) {
  const predictions = Array.isArray(data) ? data : data?.predictions || data?.detections || [];
  const unsafeLabels = new Set(["female_breast_exposed", "female_genitalia_exposed", "male_genitalia_exposed", "anus_exposed", "buttocks_exposed"]);
  const score = predictions.reduce((max, item) => {
    const label = String(item.class || item.label || item.name || "").toLowerCase();
    if (!unsafeLabels.has(label)) return max;
    return Math.max(max, scoreFromObject(item));
  }, Number(data?.score || 0));
  return { score, details: data };
}

function normalizeCustom(data) {
  const score = Math.max(
    Number(data?.score || 0),
    Number(data?.nsfwScore || 0),
    Number(data?.unsafeScore || 0),
    data?.nsfw === true || data?.unsafe === true || data?.adult === true ? 1 : 0,
  );
  return { score, details: data };
}

function parseJsonText(text = "") {
  const cleaned = String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function geminiSafetyScore(data) {
  if (data?.promptFeedback?.blockReason) return 1;
  const ratings = data?.candidates?.[0]?.safetyRatings || [];
  const sexual = ratings.find((rating) => String(rating.category || "").includes("SEXUALLY_EXPLICIT"));
  const probability = String(sexual?.probability || "").toUpperCase();
  if (probability === "HIGH") return 1;
  if (probability === "MEDIUM") return 0.85;
  if (probability === "LOW") return 0.35;
  return 0;
}

function geminiSafetyReason(data) {
  if (data?.promptFeedback?.blockReason) return `blocked:${data.promptFeedback.blockReason}`;
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason) return `finish:${finishReason}`;
  return "";
}

function normalizeGemini(data) {
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  const parsed = parseJsonText(text);
  const safetyScore = geminiSafetyScore(data);
  const score = Math.max(
    Number(parsed?.score || 0),
    Number(parsed?.nsfwScore || 0),
    parsed?.nsfw === true || parsed?.unsafe === true ? 1 : 0,
    safetyScore,
  );
  return {
    score,
    reason: parsed?.reason || geminiSafetyReason(data) || "gemini",
    details: { result: parsed, rawText: text, safetyRatings: candidate?.safetyRatings, promptFeedback: data?.promptFeedback },
  };
}

async function postMultipart(url, buffer, { signal, fields = {}, filename = "media.bin", mimeType = "application/octet-stream" } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
  }
  form.append("media", new Blob([buffer], { type: mimeType }), filename);
  const response = await fetch(url, { method: "POST", body: form, signal });
  if (!response.ok) throw new Error(`NSFW provider HTTP ${response.status}`);
  return response.json();
}

async function postJson(url, body, { signal, apiKey }) {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `NSFW provider HTTP ${response.status}`);
  return data;
}

function makeDisabledProvider() {
  return {
    name: "disabled",
    async analyze() {
      return { skipped: true, score: 0, provider: "disabled", reason: "NSFW_PROVIDER no configurado" };
    },
  };
}

function makeLocalProvider() {
  const S = 150;
  const G = 6;

  function hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    return { h, s: mx > 0 ? d / mx : 0, v: mx };
  }

  return {
    name: "local",
    async analyze(buffer, options = {}) {
      try {
        const img = sharp(buffer);
        const metadata = await img.metadata();
        const fmt = metadata?.format || "";
        if (!["jpeg", "png", "webp", "gif"].includes(fmt)) {
          return { skipped: true, score: 0, provider: "local", reason: "formato no soportado" };
        }

        const { data, info } = await img
          .resize(S, S, { fit: "cover" })
          .raw()
          .toBuffer({ resolveWithObject: true });

        const ch = info.channels || 3;
        if (ch < 3) {
          return { score: 0, nsfw: false, reason: "sin canales de color", provider: "local" };
        }

        const cell = S / G;
        let fleshG = 0, bloodG = 0;
        const fR = new Array(G * G).fill(0);
        const bR = new Array(G * G).fill(0);
        const pR = new Array(G * G).fill(0);

        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const i = (y * S + x) * ch;
            const p = { r: data[i], g: data[i + 1], b: data[i + 2] };
            const c = hsv(p.r, p.g, p.b);
            const ri = Math.min(Math.floor(y / cell), G - 1) * G + Math.min(Math.floor(x / cell), G - 1);

            if (c.h >= 0 && c.h <= 50 && c.s >= 0.22 && c.s <= 0.70 && c.v >= 0.25 && c.v <= 0.97) {
              fleshG++; fR[ri]++;
            } else if ((c.h <= 15 || c.h >= 340) && c.s >= 0.40 && c.v >= 0.20 && c.v <= 0.85) {
              bloodG++; bR[ri]++;
            }
            pR[ri]++;
          }
        }

        let cellsWithFlesh = 0;
        for (let r = 0; r < G * G; r++) {
          if (pR[r] > 0 && fR[r] / pR[r] > 0.15) cellsWithFlesh++;
        }

        let cellsWithBlood = 0;
        for (let r = 0; r < G * G; r++) {
          if (pR[r] > 0 && bR[r] / pR[r] > 0.10) cellsWithBlood++;
        }

        const total = S * S;
        const fleshRatio = fleshG / total;
        const bloodRatio = bloodG / total;

        const fleshScore = cellsWithFlesh >= 3 ? Math.min(1, fleshRatio * 1.7) : 0;
        const bloodScore = cellsWithBlood >= 2 ? Math.min(1, bloodRatio * 2.5) : 0;

        const score = Math.min(1, Math.max(fleshScore, bloodScore));

        const reasons = [];
        if (fleshRatio > 0.15) reasons.push(`piel ${(fleshRatio * 100).toFixed(0)}%`);
        if (bloodRatio > 0.05) reasons.push(`sangre ${(bloodRatio * 100).toFixed(0)}%`);

        return {
          score,
          nsfw: false,
          reason: reasons.length ? `Posible NSFW (${reasons.join(", ")})` : "Contenido seguro",
          provider: "local",
          details: { fleshRatio, bloodRatio },
        };
      } catch (err) {
        console.warn("[nsfw] Error análisis local:", err?.message || err);
        return { score: 0, nsfw: false, reason: "error análisis", provider: "local" };
      }
    },
  };
}

function makeSightengineProvider(config) {
  return {
    name: "sightengine",
    async analyze(buffer, options = {}) {
      const data = await postMultipart(config.sightengineUrl, buffer, {
        ...options,
        fields: {
          models: env("SIGHTENGINE_MODELS", "nudity-2.1"),
          api_user: env("SIGHTENGINE_API_USER"),
          api_secret: env("SIGHTENGINE_API_SECRET"),
        },
      });
      return { ...normalizeSightengine(data), provider: "sightengine" };
    },
  };
}

function makeNudeNetProvider() {
  const url = env("NUDENET_URL", env("NSFW_NUDENET_URL"));
  if (!url) return makeDisabledProvider();
  return {
    name: "nudenet",
    async analyze(buffer, options = {}) {
      const data = await postMultipart(url, buffer, options);
      return { ...normalizeNudeNet(data), provider: "nudenet" };
    },
  };
}

function makeCustomProvider() {
  const url = env("NSFW_CUSTOM_URL");
  if (!url) return makeDisabledProvider();
  return {
    name: "custom",
    async analyze(buffer, options = {}) {
      const data = await postMultipart(url, buffer, options);
      return { ...normalizeCustom(data), provider: "custom" };
    },
  };
}

function makeGeminiProvider(config) {
  const apiKey = env("GEMINI_API_KEY");
  if (!apiKey) return makeLocalProvider();

  const model = env("NSFW_GEMINI_MODEL", env("GEMINI_MODEL", "gemini-2.5-flash"));
  const apiUrl = env("GEMINI_API_URL", config.geminiApiUrl).replace(/\/$/, "");
  const fallback = makeLocalProvider();

  return {
    name: "gemini",
    async analyze(buffer, options = {}) {
      try {
        const url = `${apiUrl}/models/${encodeURIComponent(model)}:generateContent`;
        const data = await postJson(
          url,
          {
            system_instruction: {
              parts: [
                {
                  text: [
                    "Eres un clasificador de seguridad de contenido visual para moderacion.",
                    "Debes responder solo JSON valido.",
                    "Marca NSFW si hay desnudez explicita, genitales, actividad sexual o contenido sexual claro.",
                    "No marques NSFW por ropa normal, memes no sexuales, arte no explicito o ambiguedad baja.",
                  ].join(" "),
                },
              ],
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: 'Analiza esta media. Responde SOLO este JSON compacto, sin markdown ni explicacion: {"nsfw":false,"score":0,"reason":"breve"}. Usa true y score alto si hay desnudez explicita o sexual.',
                  },
                  {
                    inline_data: {
                      mime_type: options.mimeType || "application/octet-stream",
                      data: buffer.toString("base64"),
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 256,
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 },
            },
          },
          { signal: options.signal, apiKey },
        );
        return { ...normalizeGemini(data), provider: "gemini" };
      } catch (err) {
        console.warn("[nsfw] Gemini falló, usando local:", err?.message || err);
        return fallback.analyze(buffer, options);
      }
    },
  };
}

function makeOpenaiNsfwProvider(config) {
  const client = new OpenAI({
    apiKey: env("OPENAI_API_KEY"),
    baseURL: env("OPENAI_BASE_URL", "https://integrate.api.nvidia.com/v1"),
  });
  const model = env("NSFW_OPENAI_MODEL", "nvidia/nemotron-3-ultra-550b-a55b");
  const fallback = makeLocalProvider();

  return {
    name: "openai",
    async analyze(buffer, options = {}) {
      try {
        const b64 = buffer.toString("base64");
        const mimeType = options.mimeType || "image/jpeg";

        const completion = await client.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a visual content safety classifier. Answer ONLY valid JSON. " +
                  'Mark NSFW=true only for explicit nudity, genitals, sexual activity, or clear sexual content. ' +
                  "Do NOT mark NSFW for normal clothing, non-sexual memes, non-explicit art, or low ambiguity.",
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      'Analyze this image. Respond ONLY this compact JSON, no markdown, no explanation: {"nsfw":false,"score":0,"reason":"brief"}. ' +
                      "Use true and high score if explicit nudity or sexual content is present.",
                  },
                  {
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${b64}` },
                  },
                ],
              },
            ],
            temperature: 0,
            max_tokens: 256,
          },
          { signal: options.signal },
        );

        const text = completion.choices?.[0]?.message?.content || "";
        const parsed = parseJsonText(text);
        const score = Math.max(
          Number(parsed?.score || 0),
          Number(parsed?.nsfwScore || 0),
          parsed?.nsfw === true || parsed?.unsafe === true ? 1 : 0,
        );
        return {
          score,
          reason: parsed?.reason || "openai",
          provider: "openai",
          details: { result: parsed, rawText: text },
        };
      } catch (err) {
        console.warn("[nsfw] OpenAI falló, usando local:", err?.message || err);
        return fallback.analyze(buffer, options);
      }
    },
  };
}

const NVIDIA_UNSAFE_TOKENS = [
  "explicit", "sexual", "porn", "nudity", "gore", "violence",
  "self-harm", "illegal", "hate", "harassment", "extremism",
];

export function normalizeNvidia(text = "") {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  const safetyMatch = lower.match(/user safety:\s*(safe|unsafe)/);
  const unsafe = safetyMatch ? safetyMatch[1] === "unsafe" : null;

  const catMatch = raw.match(/safety categories:\s*([^\n\r]+)/i);
  const categories = (catMatch ? catMatch[1] : "").trim();

  const matched = NVIDIA_UNSAFE_TOKENS.filter((token) => categories.toLowerCase().includes(token));

  const score = unsafe ? 1 : matched.length > 0 ? 0.9 : 0;
  const reason =
    unsafe || matched.length > 0
      ? categories || (unsafe ? "contenido inseguro" : "categoría de riesgo")
      : "contenido seguro";

  return {
    score,
    reason,
    provider: "nvidia",
    details: { rawText: raw, categories, unsafe },
  };
}

function makeNvidiaProvider() {
  const apiKey = env("NSFW_NVIDIA_API_KEY");
  if (!apiKey) return makeLocalProvider();

  const client = new OpenAI({
    apiKey,
    baseURL: env("NSFW_NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
  });
  const model = env("NSFW_NVIDIA_MODEL", "nvidia/nemotron-3.5-content-safety");
  const fallback = makeLocalProvider();

  return {
    name: "nvidia",
    async analyze(buffer, options = {}) {
      try {
        const b64 = buffer.toString("base64");
        const mimeType = options.mimeType || "image/jpeg";
        const completion = await client.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Classify this image for content safety." },
                  { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } },
                ],
              },
            ],
            max_tokens: 100,
            temperature: 0.01,
            top_p: 0.95,
            extra_body: {
              chat_template_kwargs: { request_categories: "/categories", enable_thinking: false },
            },
          },
          { signal: options.signal },
        );

        const text = completion.choices?.[0]?.message?.content || "";
        return normalizeNvidia(text);
      } catch (err) {
        console.warn("[nsfw] NVIDIA falló, usando local:", err?.message || err);
        return fallback.analyze(buffer, options);
      }
    },
  };
}

function makeOpenrouterProvider(config) {
  const client = new OpenAI({
    apiKey: env("OPENROUTER_API_KEY"),
    baseURL: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  });
  const model = env("NSFW_OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it:free");
  const fallback = makeLocalProvider();

  return {
    name: "openrouter",
    async analyze(buffer, options = {}) {
      try {
        const b64 = buffer.toString("base64");
        const mimeType = options.mimeType || "image/jpeg";

        const completion = await client.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a visual content safety classifier. Answer ONLY valid JSON. " +
                  'Mark NSFW=true only for explicit nudity, genitals, sexual activity, or clear sexual content. ' +
                  "Do NOT mark NSFW for normal clothing, non-sexual memes, non-explicit art, or low ambiguity.",
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      'Analyze this image. Respond ONLY this compact JSON, no markdown, no explanation: {"nsfw":false,"score":0,"reason":"brief"}. ' +
                      "Use true and high score if explicit nudity or sexual content is present.",
                  },
                  {
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${b64}` },
                  },
                ],
              },
            ],
            temperature: 0,
            max_tokens: 256,
          },
          { signal: options.signal },
        );

        const text = completion.choices?.[0]?.message?.content || "";
        const parsed = parseJsonText(text);
        const score = Math.max(
          Number(parsed?.score || 0),
          Number(parsed?.nsfwScore || 0),
          parsed?.nsfw === true || parsed?.unsafe === true ? 1 : 0,
        );
        return {
          score,
          reason: parsed?.reason || "openrouter",
          provider: "openrouter",
          details: { result: parsed, rawText: text },
        };
      } catch (err) {
        console.warn("[nsfw] OpenRouter falló, usando local:", err?.message || err);
        return fallback.analyze(buffer, options);
      }
    },
  };
}

export function getNsfwConfig() {
  return {
    provider: env("NSFW_PROVIDER", DEFAULTS.provider).toLowerCase(),
    threshold: envNumber("NSFW_THRESHOLD", DEFAULTS.threshold),
    timeoutMs: envNumber("NSFW_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxBytes: envNumber("NSFW_MAX_BYTES", 8 * 1024 * 1024),
    cacheTtlMs: envNumber("NSFW_CACHE_TTL_MS", 10 * 60 * 1000),
    cacheMaxEntries: envNumber("NSFW_CACHE_MAX_ENTRIES", 100),
    kickThreshold: envNumber("NSFW_KICK_THRESHOLD", 3),
    sightengineUrl: env("SIGHTENGINE_URL", DEFAULTS.sightengineUrl),
    geminiApiUrl: env("GEMINI_API_URL", DEFAULTS.geminiApiUrl),
  };
}

export function createNsfwProvider(config = getNsfwConfig()) {
  if (config.provider === "gemini") return makeGeminiProvider(config);
  if (config.provider === "openai") return makeOpenaiNsfwProvider(config);
  if (config.provider === "nvidia") return makeNvidiaProvider(config);
  if (config.provider === "openrouter") return makeOpenrouterProvider(config);
  if (config.provider === "local") return makeLocalProvider();
  if (config.provider === "sightengine") return makeSightengineProvider(config);
  if (config.provider === "nudenet") return makeNudeNetProvider(config);
  if (config.provider === "custom") return makeCustomProvider(config);
  return makeDisabledProvider();
}
