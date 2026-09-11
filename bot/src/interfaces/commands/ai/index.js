import { AiStore } from "../../../infrastructure/storage/aiStore.js";
import { GeminiClient } from "../../../infrastructure/ai/geminiClient.js";
import { OpenaiClient } from "../../../infrastructure/ai/openaiClient.js";
import { getAiConfig } from "../../../infrastructure/ai/aiConfig.js";
import { sameParticipant } from "../../../shared/utils/jid.js";

const COMMANDS = ["ai", "ask", "resume", "resumen", "aireset", "aistatus"];
const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;
const lastRequests = new Map();

function promptFrom(ctx) {
  const text = (ctx.args || []).join(" ").trim();
  return text.replace(/\s+/g, " ");
}

function mentionedJids(ctx) {
  return ctx.raw.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

function mentionsBot(ctx, ownerRepository) {
  const botIds = [ctx.botJid, ctx.botLid, ...ownerRepository.botNumberJids()].filter(Boolean);
  return mentionedJids(ctx).some((mentioned) =>
    botIds.some((botId) => sameParticipant(mentioned, botId)),
  );
}

function promptFromMention(ctx) {
  const mentions = mentionedJids(ctx).map((jid) => `@${jid.split("@")[0]}`);
  let text = ctx.text || "";
  for (const mention of mentions) {
    text = text.replaceAll(mention, "");
  }
  return text.replace(/\s+/g, " ").trim() || "Responde de forma breve y util al mensaje donde te mencionaron.";
}

function trimPrompt(prompt, maxChars) {
  if (prompt.length <= maxChars) return prompt;
  return prompt.slice(0, maxChars).trim();
}

function rateLimitKey(ctx) {
  return `${ctx.phone}:${ctx.sender}`;
}

function isRateLimited(ctx, delayMs) {
  const key = rateLimitKey(ctx);
  const current = Date.now();
  const previous = lastRequests.get(key) || 0;
  if (current - previous < delayMs) return true;
  lastRequests.set(key, current);
  return false;
}

function usage(ctx) {
  return [
    "🤖 *Asistente IA*",
    `${ctx.prefix}ai <pregunta> — hacerme una pregunta`,
    `${ctx.prefix}resume — resumen de las últimas 24h`,
    `${ctx.prefix}aireset — borrar el historial`,
    `${ctx.prefix}aistatus — ver el estado del módulo`,
  ].join("\n");
}

function makeMessages(config, history, prompt, name) {
  return [
    { role: "system", content: config.systemPrompt },
    ...history,
    { role: "user", content: `${name}: ${prompt}` },
  ];
}

function messageTranscript(messages) {
  return messages
    .map((message) => {
      const time = new Date(message.at).toLocaleString("es-CO", {
        hour12: false,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `[${time}] ${message.name || message.sender}: ${message.text}`;
    })
    .join("\n");
}

function makeSummaryMessages(config, messages) {
  const transcript = messageTranscript(messages).slice(-12000);
  return [
    {
      role: "system",
      content: [
        config.systemPrompt,
        "Resume conversaciones de WhatsApp con privacidad y precision.",
        "No inventes eventos. Si algo no esta claro, dilo como posible.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        "Resume las ultimas 24 horas de este chat.",
        "Incluye: temas principales, acuerdos o decisiones, pendientes, menciones importantes y tono general.",
        "Usa bullets cortos y termina con una linea de 'Pendientes'.",
        "",
        transcript,
      ].join("\n"),
    },
  ];
}

function makeHandler(options = {}) {
  const config = { ...getAiConfig(), ...options };
  const store = new AiStore({
    maxHistoryMessages: config.maxHistoryMessages,
    maxStoredMessages: config.maxStoredMessages,
    messageRetentionMs: config.messageRetentionMs,
  });
  const client = options.client || (config.provider === "openai" ? new OpenaiClient(config) : new GeminiClient(config));
  const ownerRepository = options.ownerRepository;

  return async (ctx) => {
    await store.ready();

    const botMentioned = !ctx.isCommand && !ctx.raw.key?.fromMe && mentionsBot(ctx, ownerRepository);

    if (ctx.text && !ctx.isCommand && !ctx.raw.key?.fromMe) {
      store.recordMessage(ctx.phone, {
        sender: ctx.sender,
        name: ctx.name,
        text: ctx.text,
      });
    }

    if (!botMentioned && (!ctx.isCommand || !COMMANDS.includes(ctx.command))) return null;

    if (ctx.command === "aistatus") {
      const chat = store.chat(ctx.phone);
      const isOpenai = config.provider === "openai";
      const hasKey = isOpenai ? Boolean(config.openaiApiKey) : Boolean(config.apiKey);
      return [
        "🤖 *Estado de la IA*",
        `Proveedor: ${isOpenai ? "OpenAI (NVIDIA)" : "Gemini"}`,
        `Modelo: ${isOpenai ? config.openaiModel : config.model}`,
        `API key: ${hasKey ? "✅ configurada" : "❌ faltante"}`,
        `Historial: ${chat.history.length}/${config.maxHistoryMessages} mensajes`,
        `Almacenados: ${chat.messages.length}/${config.maxStoredMessages}`,
      ].join("\n");
    }

    if (ctx.command === "aireset") {
      store.reset(ctx.phone);
      store.log({ type: "reset", chat: ctx.phone, by: ctx.sender });
      return "✅ Historial de la IA borrado para este chat.";
    }

    if (ctx.command === "resume" || ctx.command === "resumen") {
      if (isRateLimited(ctx, config.rateLimitMs)) {
        return "⏳ Espera unos segundos antes de volver a consultar la IA.";
      }

      const recent = store.recentMessages(ctx.phone, SUMMARY_WINDOW_MS);
      if (recent.length === 0) return "No hay mensajes de las últimas 24 horas para resumir. ¡Hablen más! 💬";

      const started = Date.now();
      const result = await client.chat(makeSummaryMessages(config, recent));
      const latencyMs = Date.now() - started;

      store.log({
        type: result.ok ? "summary" : "summary-error",
        chat: ctx.phone,
        by: ctx.sender,
        model: result.model || config.model,
        latencyMs,
        messages: recent.length,
        error: result.ok ? undefined : result.error,
        usage: result.usage,
      });

      if (!result.ok) return `Algo salió mal al resumir el chat 😕 (${result.error})`;
      return result.content;
    }

    const prompt = trimPrompt(botMentioned ? promptFromMention(ctx) : promptFrom(ctx), config.maxPromptChars);
    if (!prompt) return usage(ctx);

    if (isRateLimited(ctx, config.rateLimitMs)) {
      return "⏳ Espera unos segundos antes de volver a consultar la IA.";
    }

    const history = store.messages(ctx.phone);
    const messages = makeMessages(config, history, prompt, ctx.name);
    const started = Date.now();
    const result = await client.chat(messages);
    const latencyMs = Date.now() - started;

    store.log({
      type: result.ok ? "completion" : "error",
      chat: ctx.phone,
      by: ctx.sender,
      model: result.model || config.model,
      latencyMs,
      promptChars: prompt.length,
      error: result.ok ? undefined : result.error,
      usage: result.usage,
    });

    if (!result.ok) {
      return `Algo salió mal al consultar la IA 😕 (${result.error})`;
    }

    store.append(ctx.phone, "user", prompt);
    store.append(ctx.phone, "assistant", result.content);
    return result.content;
  };
}

export const aiPlugin = {
  name: "ai",
  version: "1.0.0",
  register(router, options = {}) {
    router.register(makeHandler(options), {
      category: "IA",
      commands: COMMANDS,
    });
  },
};
