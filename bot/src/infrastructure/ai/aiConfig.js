import { env, envNumber } from "../../shared/config/env.js";

const DEFAULTS = {
  apiUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-3.5-flash",
  temperature: 0.4,
  maxTokens: 700,
  timeoutMs: 20000,
  maxPromptChars: 2500,
  maxHistoryMessages: 8,
  maxStoredMessages: 1200,
  messageRetentionMs: 48 * 60 * 60 * 1000,
  rateLimitMs: 3500,
  systemPrompt: [
    "Eres BandalandBot, un asistente util para grupos de WhatsApp.",
    "Responde en espanol claro, breve y accionable.",
    "No inventes datos si no estas seguro.",
    "Tu creador es juanito. No lo menciones ni lo presentes salvo que te pregunten directamente quien te creo.",
    "Trata a todos con respeto: no insultes, no uses lenguaje vulgar y no inventes opiniones sobre personas.",
    "No menciones ni opines sobre terceros salvo que el usuario lo pida y sea relevante.",
  ].join(" "),
  provider: "gemini",
  openaiApiKey: "",
  openaiBaseUrl: "https://integrate.api.nvidia.com/v1",
  openaiModel: "meta/llama-3.1-70b-instruct",
  openaiTemperature: 0.7,
  openaiMaxTokens: 700,
};

export function getAiConfig() {
  return {
    apiKey: env("GEMINI_API_KEY"),
    apiUrl: env("GEMINI_API_URL", DEFAULTS.apiUrl),
    model: env("GEMINI_MODEL", DEFAULTS.model),
    temperature: envNumber("GEMINI_TEMPERATURE", DEFAULTS.temperature),
    maxTokens: envNumber("GEMINI_MAX_TOKENS", DEFAULTS.maxTokens),
    timeoutMs: envNumber("GEMINI_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxPromptChars: envNumber("AI_MAX_PROMPT_CHARS", DEFAULTS.maxPromptChars),
    maxHistoryMessages: envNumber("AI_MAX_HISTORY_MESSAGES", DEFAULTS.maxHistoryMessages),
    maxStoredMessages: envNumber("AI_MAX_STORED_MESSAGES", DEFAULTS.maxStoredMessages),
    messageRetentionMs: envNumber("AI_MESSAGE_RETENTION_MS", DEFAULTS.messageRetentionMs),
    rateLimitMs: envNumber("AI_RATE_LIMIT_MS", DEFAULTS.rateLimitMs),
    systemPrompt: env("AI_SYSTEM_PROMPT", DEFAULTS.systemPrompt),
    provider: env("AI_PROVIDER", DEFAULTS.provider),
    openaiApiKey: env("OPENAI_API_KEY", DEFAULTS.openaiApiKey),
    openaiBaseUrl: env("OPENAI_BASE_URL", DEFAULTS.openaiBaseUrl),
    openaiModel: env("OPENAI_MODEL", DEFAULTS.openaiModel),
    openaiTemperature: envNumber("OPENAI_TEMPERATURE", DEFAULTS.openaiTemperature),
    openaiMaxTokens: envNumber("OPENAI_MAX_TOKENS", DEFAULTS.openaiMaxTokens),
  };
}
