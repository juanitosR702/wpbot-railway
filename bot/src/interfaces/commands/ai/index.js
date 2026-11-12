import { getAiConfig } from "../../../infrastructure/ai/aiConfig.js";
import { envNumber } from "../../../shared/config/env.js";
import { sameParticipant, cleanJid, findParticipant, jidUser } from "../../../shared/utils/jid.js";
import { HALT } from "../../bot/router.js";
import { createCommandCatalog } from "./commandCatalog.js";
import { createCommandRunner } from "./commandRunner.js";

const COMMANDS = ["ai", "ia", "ask", "resume", "resumen", "aireset", "aistatus"];
const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TOOL_ROUNDS = 3;
const DEFAULT_CONFIRM_MS = 90 * 1000;
const MAX_PENDING = 200;
const MAX_TOOL_RESULT_CHARS = 400;

const lastRequests = new Map();
// Una confirmacion pendiente por chat. Se borra al confirmar, cancelar o caducar.
const pendingConfirmations = new Map();

const CONFIRM_RE = /^(si|sii|sip|sisas|dale|de una|deuna|confirmo|confirmado|ok|okay|hazlo|hagalo|adelante|claro|yes|va|listo)( (por favor|porfa|hazlo|ya|pues))?$/;
const CANCEL_RE = /^(no|nop|nel|nada|cancela|cancelalo|cancelar|olvidalo|mejor no|dejalo)( (por favor|porfa))?$/;

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9@ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeText(text).split(" ").filter((token) => token.length > 1);
}

function contextInfoOf(ctx) {
  const message = ctx.raw?.message || {};
  return (
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    null
  );
}

function mentionedJids(ctx) {
  return contextInfoOf(ctx)?.mentionedJid || [];
}

function botIds(ctx, ownerRepository) {
  return [ctx.botJid, ctx.botLid, ...(ownerRepository?.botNumberJids?.() || [])].filter(Boolean);
}

function mentionsBot(ctx, ownerRepository) {
  const ids = botIds(ctx, ownerRepository);
  return mentionedJids(ctx).some((mentioned) => ids.some((id) => sameParticipant(mentioned, id)));
}

function promptFrom(ctx) {
  const text = (ctx.args || []).join(" ").trim();
  return text.replace(/\s+/g, " ");
}

function trimPrompt(prompt, maxChars) {
  if (prompt.length <= maxChars) return prompt;
  return prompt.slice(0, maxChars).trim();
}

function truncate(text, maxChars = MAX_TOOL_RESULT_CHARS) {
  const value = String(text || "");
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
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
    `${ctx.prefix}ai <pregunta> — hacerme una pregunta (también ${ctx.prefix}ia)`,
    `${ctx.prefix}resume — resumen de las últimas 24h`,
    `${ctx.prefix}aireset — borrar el historial`,
    `${ctx.prefix}aistatus — ver el estado del módulo`,
    "",
    "Solo respondo al comando. Mencionarme o responder a un mensaje mío ya no me activa.",
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

function confirmWindowMs() {
  const value = envNumber("AI_COMMAND_CONFIRM_MS", DEFAULT_CONFIRM_MS);
  return Math.max(15000, Math.min(5 * 60 * 1000, value));
}

function prunePending() {
  const now = Date.now();
  for (const [phone, pending] of pendingConfirmations) {
    if (now - pending.at > pending.ttlMs) pendingConfirmations.delete(phone);
  }
  while (pendingConfirmations.size >= MAX_PENDING) {
    pendingConfirmations.delete(pendingConfirmations.keys().next().value);
  }
}

function confirmationText(entry, args, ttlMs) {
  const command = `!${entry.name}${args.length ? ` ${args.join(" ")}` : ""}`;
  const seconds = Math.round(ttlMs / 1000);
  return [
    "⚠️ *Confirmación requerida*",
    `Voy a ejecutar: *${truncate(command, 120)}*`,
    `Responde *sí* para confirmarlo o *no* para cancelar. Caduca en ${seconds} s.`,
  ].join("\n");
}

function summarizeCommand(entry) {
  return {
    nombre: entry.name,
    descripcion: entry.desc || "(sin descripcion)",
    nivel: entry.level,
    uso: entry.usage,
    destructivo: entry.destructive,
    requiereObjetivo: entry.needsTarget,
  };
}

function toolDefinitions() {
  return [
    {
      name: "buscar_comandos",
      description:
        "Busca comandos del bot a partir de lo que el usuario quiere hacer. Devuelve hasta 6 resultados con descripcion, nivel y uso.",
      parameters: {
        type: "object",
        properties: {
          consulta: {
            type: "string",
            description: "Lo que el usuario quiere hacer, en sus palabras. Ej: 'expulsar a alguien', 'dar monedas'.",
          },
        },
        required: ["consulta"],
      },
    },
    {
      name: "ver_comando",
      description: "Devuelve el uso, los permisos y los detalles exactos de un comando por su nombre (sin el prefijo).",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "Nombre exacto del comando, sin '!'." },
        },
        required: ["nombre"],
      },
    },
    {
      name: "buscar_persona",
      description:
        "Busca a una persona del chat por su nombre o apodo. Devuelve su JID y numero para usarlo como objetivo de un comando.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "Nombre o apodo de la persona." },
        },
        required: ["nombre"],
      },
    },
    {
      name: "ejecutar_comando",
      description:
        "Ejecuta un comando del bot. Los comandos destructivos piden confirmacion automatica al usuario. Devuelve el resultado real.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "Nombre exacto del comando, sin '!'." },
          argumentos: {
            type: "string",
            description:
              "Argumentos separados por espacios. Para objetivos usa el JID que devuelve buscar_persona, una mencion o un numero.",
          },
        },
        required: ["nombre"],
      },
    },
  ];
}

function buildSystemPrompt(config, catalog) {
  return [
    config.systemPrompt,
    "",
    "Puedes ejecutar comandos del bot cuando alguien te lo pida en lenguaje natural.",
    "Reglas:",
    "- Para actuar llama a ejecutar_comando. Nunca digas que ejecutaste algo sin haberlo hecho.",
    "- Si no sabes el comando exacto, usa buscar_comandos o ver_comando antes de ejecutar.",
    "- Si falta un dato (a quien, cuanto, que opcion), pregunta en vez de adivinar.",
    "- Para encontrar a una persona por su nombre usa buscar_persona y pasa su JID en los argumentos.",
    "- Los comandos destructivos piden confirmacion automaticamente: no la pidas tu, solo llama a la funcion.",
    "- Si el comando ya respondio por su cuenta, responde exactamente: NADA",
    "- Si el usuario solo conversa, responde breve y no ejecutes nada.",
    "",
    "Comandos disponibles:",
    catalog.compactIndex(),
  ].join("\n");
}

function splitArgs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

async function buscarPersona(ctx, query, store) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];

  const matches = new Map();
  for (const message of store.recentMessages(ctx.phone, SUMMARY_WINDOW_MS)) {
    if (!message.sender) continue;
    const name = String(message.name || "").trim();
    const nameNorm = normalizeText(name);
    const haystack = normalizeText(`${name} ${message.text || ""}`);
    let points = 0;
    for (const token of tokens) {
      if (nameNorm.includes(token)) points += 3;
      else if (haystack.includes(token)) points += 1;
    }
    if (!points) continue;

    const key = cleanJid(message.sender);
    const previous = matches.get(key);
    if (!previous || points > previous.points) {
      matches.set(key, {
        points,
        nombre: name || key,
        jid: message.jid || `${key}@s.whatsapp.net`,
        sender: key,
      });
    }
  }

  if (!matches.size) return [];

  let metadata = null;
  if (ctx.isGroup && typeof ctx.getGroupMetadata === "function") {
    metadata = await ctx.getGroupMetadata().catch(() => null);
  }

  const resolved = new Map();
  for (const candidate of matches.values()) {
    const found = metadata ? findParticipant(metadata, [candidate.jid, candidate.sender]) : null;
    const jid = found?.id || candidate.jid;
    const key = cleanJid(jid);
    if (!key || resolved.has(key)) continue;
    resolved.set(key, { nombre: candidate.nombre, jid, numero: jidUser(jid) });
  }

  return [...resolved.values()].slice(0, 8);
}

function createToolExecutor({ ctx, store, catalog, runner }) {
  async function stageCommand(args) {
    const name = String(args?.nombre || "").trim();
    const entry = catalog.get(name);
    if (!entry) {
      return {
        response: { ok: false, error: `El comando "${name}" no existe. Usa buscar_comandos para encontrar el correcto.` },
      };
    }

    const denied = await runner.checkPermission(entry, ctx);
    if (denied) {
      return { response: { ok: false, error: denied, denegado: true } };
    }

    const argList = splitArgs(args?.argumentos);
    if (entry.needsTarget && !runner.hasTarget(ctx, argList)) {
      return {
        response: {
          ok: false,
          error: "Falta el objetivo: indica a que persona con buscar_persona, una mencion o un numero.",
        },
      };
    }

    if (entry.destructive) {
      prunePending();
      const ttlMs = confirmWindowMs();
      pendingConfirmations.set(ctx.phone, {
        sender: ctx.sender,
        at: Date.now(),
        ttlMs,
        entry,
        args: argList,
        synthetic: runner.buildSyntheticMessage(ctx, entry, argList),
      });
      return { stopText: confirmationText(entry, argList, ttlMs) };
    }

    const result = await runner.run(entry.name, argList, ctx);
    if (!result.ok) {
      return { response: { ok: false, error: result.error } };
    }

    let sent = false;
    if (result.reply !== null && result.reply !== undefined) {
      try {
        await ctx.sendMessage(result.reply);
        sent = true;
      } catch (err) {
        return {
          response: { ok: false, error: `El comando se ejecutó pero no pude enviar su respuesta: ${err?.message || err}` },
        };
      }
    }

    return {
      response: {
        ok: true,
        comando: entry.name,
        enviado: sent,
        resultado: typeof result.reply === "string" ? truncate(result.reply) : undefined,
        nota: "El comando ya respondio al usuario. No repitas su contenido.",
      },
      executed: true,
    };
  }

  async function execute(name, args) {
    if (name === "buscar_comandos") {
      const query = String(args?.consulta || "").trim();
      const results = catalog.search(query, 6);
      return {
        response: {
          ok: true,
          resultados: results.map(summarizeCommand),
          ...(results.length ? {} : { nota: "Sin coincidencias. Prueba con otras palabras o pide el listado por categoria." }),
        },
      };
    }

    if (name === "ver_comando") {
      const entry = catalog.get(String(args?.nombre || "").trim());
      if (!entry) return { response: { ok: false, error: `No existe el comando "${args?.nombre || ""}".` } };
      return {
        response: {
          ok: true,
          nombre: entry.name,
          categoria: entry.category,
          descripcion: entry.desc,
          uso: entry.usage,
          nivel: entry.level,
          destructivo: entry.destructive,
          requiereObjetivo: entry.needsTarget,
        },
      };
    }

    if (name === "buscar_persona") {
      const query = String(args?.nombre || "").trim();
      const people = await buscarPersona(ctx, query, store);
      return {
        response: {
          ok: true,
          personas: people,
          ...(people.length ? {} : { nota: "No encontre coincidencias en los mensajes recientes." }),
        },
      };
    }

    if (name === "ejecutar_comando") return stageCommand(args);

    return { response: { ok: false, error: `Herramienta desconocida: ${name}` } };
  }

  return { execute };
}

async function runWithTools({ ctx, prompt, history, config, client, catalog, runner, store }) {
  const turns = history
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role === "assistant" ? "model" : "user", text: message.content }));
  turns.push({ role: "user", text: `${ctx.name}: ${prompt}` });

  const system = buildSystemPrompt(config, catalog);
  const tools = toolDefinitions();
  const executor = createToolExecutor({ ctx, store, catalog, runner });
  let executed = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await client.chatWithTools({ system, turns, tools });
    if (!result.ok) {
      return { ok: false, error: result.error, unsupported: result.unsupportedTools, executed };
    }

    if (!result.functionCall) {
      return { ok: true, content: (result.text || "").trim(), usage: result.usage, executed };
    }

    const name = result.functionCall.name;
    const args = result.functionCall.args || {};
    const callId = result.functionCall.id || `call_${round}`;

    const output = await executor.execute(name, args);

    if (output.stopText) {
      return { ok: true, content: output.stopText, usage: result.usage, executed };
    }

    if (output.executed) executed = true;

    turns.push({ role: "model", functionCall: { id: callId, name, args } });
    turns.push({ role: "user", functionResponse: { id: callId, name, response: output.response } });
  }

  return { ok: false, error: "La IA no terminó la orden (demasiados pasos).", executed };
}

async function handleConfirmation(ctx, { router, runner, botMentioned }) {
  const pending = pendingConfirmations.get(ctx.phone);
  if (!pending) return undefined;
  if (Date.now() - pending.at > pending.ttlMs) {
    pendingConfirmations.delete(ctx.phone);
    return undefined;
  }

  const text = normalizeText(ctx.text);
  const yes = CONFIRM_RE.test(text);
  const no = CANCEL_RE.test(text);
  if (!yes && !no) return undefined;

  const sameSender = sameParticipant(pending.sender, ctx.sender);
  if (!sameSender) {
    // Otro usuario solo puede confirmar si es admin/creador y menciona al bot.
    if (!botMentioned) return undefined;
    const perms = await runner?.permissionsFor(ctx);
    if (!perms?.creator && !perms?.admin) return undefined;
  }

  pendingConfirmations.delete(ctx.phone);

  if (no) return "❌ Cancelado, no ejecuté nada.";

  try {
    const reply = await router.route(pending.synthetic, ctx.services || {});
    return reply === null || reply === undefined ? "✅ Comando ejecutado." : reply;
  } catch (err) {
    return `⚠️ No pude ejecutar el comando (${err?.message || err}).`;
  }
}

function makeHandler(options = {}) {
  const config = { ...getAiConfig(), ...options };
  const ownerRepository = options.ownerRepository;
  const router = options.router;

  // Carga diferida: el store (Mongo) y el cliente del proveedor solo se
  // importan cuando hace falta. Asi el plugin se puede testear sin mongodb ni
  // openai instalados.
  let storeInstance = options.store || null;
  async function resolveStore() {
    if (!storeInstance) {
      const { AiStore } = await import("../../../infrastructure/storage/aiStore.js");
      storeInstance = new AiStore({
        maxHistoryMessages: config.maxHistoryMessages,
        maxStoredMessages: config.maxStoredMessages,
        messageRetentionMs: config.messageRetentionMs,
      });
    }
    await storeInstance.ready();
    return storeInstance;
  }

  let clientInstance = options.client || null;
  async function resolveClient() {
    if (clientInstance) return clientInstance;
    if (config.provider === "openai") {
      const { OpenaiClient } = await import("../../../infrastructure/ai/openaiClient.js");
      clientInstance = new OpenaiClient(config);
    } else {
      const { GeminiClient } = await import("../../../infrastructure/ai/geminiClient.js");
      clientInstance = new GeminiClient(config);
    }
    return clientInstance;
  }

  // El catalogo se construye al primer uso: al registrar el plugin todavia no
  // estan todos los comandos del router.
  let catalog = null;
  let runner = null;
  function tools() {
    if (!router) return null;
    if (!catalog) {
      catalog = createCommandCatalog(router);
      runner = createCommandRunner({
        router,
        ownerPolicy: options.ownerPolicy,
        catalog,
        botNumberJids: () => ownerRepository?.botNumberJids?.() || [],
      });
    }
    return { catalog, runner };
  }

  return async (ctx) => {
    if (ctx.raw?.__aiSynthetic) return null;
    const store = await resolveStore();

    const fromMe = Boolean(ctx.raw?.key?.fromMe);
    // La IA solo responde al comando explicito (!ai / !ia / !ask). Mencionar al
    // bot o responder a uno de sus mensajes ya NO la activa: eso solo alimenta
    // el historial y las confirmaciones.
    const isAiCommand = !fromMe && ctx.isCommand && COMMANDS.includes(ctx.command);
    const botMentioned = !fromMe && mentionsBot(ctx, ownerRepository);

    if (ctx.text && !ctx.isCommand && !fromMe) {
      store.recordMessage(ctx.phone, {
        sender: ctx.sender,
        name: ctx.name,
        text: ctx.text,
        jid: ctx.raw?.key?.participant || (ctx.isGroup ? null : ctx.raw?.key?.remoteJid),
      });
    }

    // Las confirmaciones se atienden antes del rate limit para que un "sí"
    // inmediato no se descarte.
    if (!ctx.isCommand && ctx.text && router) {
      const ready = tools();
      const confirmed = await handleConfirmation(ctx, {
        router,
        runner: ready?.runner,
        botMentioned,
      });
      if (confirmed !== undefined) return confirmed;
    }

    if (!isAiCommand) return null;

    if (ctx.command === "aistatus") {
      const chat = store.chat(ctx.phone);
      const client = await resolveClient();
      const isOpenai = config.provider === "openai";
      const hasKey = isOpenai ? Boolean(config.openaiApiKey) : Boolean(config.apiKey);
      const catalogSize = catalog ? catalog.size() : 0;
      return [
        "🤖 *Estado de la IA*",
        `Proveedor: ${isOpenai ? "OpenAI (NVIDIA)" : "Gemini"}`,
        `Modelo: ${isOpenai ? config.openaiModel : config.model}`,
        `API key: ${hasKey ? "✅ configurada" : "❌ faltante"}`,
        `Comandos conocidos: ${catalogSize}`,
        `Herramientas: ${client.supportsTools ? "✅" : "❌"}`,
        `Historial: ${chat.history.length}/${config.maxHistoryMessages} mensajes`,
        `Almacenados: ${chat.messages.length}/${config.maxStoredMessages}`,
      ].join("\n");
    }

    if (ctx.command === "aireset") {
      store.reset(ctx.phone);
      pendingConfirmations.delete(ctx.phone);
      store.log({ type: "reset", chat: ctx.phone, by: ctx.sender });
      return "✅ Historial de la IA borrado para este chat.";
    }

    if (ctx.command === "resume" || ctx.command === "resumen") {
      if (isRateLimited(ctx, config.rateLimitMs)) {
        return "⏳ Espera unos segundos antes de volver a consultar la IA.";
      }

      const recent = store.recentMessages(ctx.phone, SUMMARY_WINDOW_MS);
      if (recent.length === 0) return "No hay mensajes de las últimas 24 horas para resumir. ¡Hablen más! 💬";

      const client = await resolveClient();
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

    const prompt = trimPrompt(promptFrom(ctx), config.maxPromptChars);
    if (!prompt) return usage(ctx);

    if (isRateLimited(ctx, config.rateLimitMs)) {
      return "⏳ Espera unos segundos antes de volver a consultar la IA.";
    }

    const history = store.messages(ctx.phone);
    const started = Date.now();
    const ready = tools();
    const client = await resolveClient();
    let result;

    if (ready && client.supportsTools && typeof client.chatWithTools === "function") {
      result = await runWithTools({
        ctx,
        prompt,
        history,
        config,
        client,
        catalog: ready.catalog,
        runner: ready.runner,
        store,
      });

      if (result.unsupported) {
        const messages = makeMessages(config, history, prompt, ctx.name);
        result = await client.chat(messages);
      }
    } else {
      const messages = makeMessages(config, history, prompt, ctx.name);
      result = await client.chat(messages);
    }

    const latencyMs = Date.now() - started;

    store.log({
      type: result.ok ? "completion" : "error",
      chat: ctx.phone,
      by: ctx.sender,
      model: result.model || config.model,
      latencyMs,
      promptChars: prompt.length,
      commands: ready ? ready.catalog.size() : 0,
      error: result.ok ? undefined : result.error,
      usage: result.usage,
    });

    if (!result.ok) {
      return `Algo salió mal al consultar la IA 😕 (${result.error})`;
    }

    const content = String(result.content || "").trim();
    if (result.executed && content.toLowerCase() === "nada") return HALT;
    if (!content) return HALT;

    store.append(ctx.phone, "user", prompt);
    store.append(ctx.phone, "assistant", content);
    return content;
  };
}

export const aiPlugin = {
  name: "ai",
  version: "1.1.0",
  register(router, options = {}) {
    router.register(makeHandler(options), {
      category: "IA",
      commands: COMMANDS,
    });
  },
};
