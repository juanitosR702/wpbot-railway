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
  openaiModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  openaiTemperature: 0.7,
  openaiMaxTokens: 700,
  // Cadena de respaldo: Gemini -> OpenRouter -> NVIDIA. `openrouter/auto`
  // deja que OpenRouter elija un modelo disponible de su catalogo.
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  openrouterModel: "openrouter/auto",
  nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
  nvidiaModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  fallbackTimeoutMs: 60000,
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
    openrouterApiKey: env("OPENROUTER_API_KEY"),
    openrouterBaseUrl: env("OPENROUTER_BASE_URL", DEFAULTS.openrouterBaseUrl),
    openrouterModel: env("OPENROUTER_MODEL", DEFAULTS.openrouterModel),
    // Reutiliza la clave de NVIDIA del modulo NSFW si no hay una dedicada.
    nvidiaApiKey: env("NVIDIA_API_KEY") || env("NSFW_NVIDIA_API_KEY"),
    nvidiaBaseUrl: env("NVIDIA_BASE_URL", DEFAULTS.nvidiaBaseUrl),
    nvidiaModel: env("NVIDIA_MODEL", DEFAULTS.nvidiaModel),
    fallbackTimeoutMs: envNumber("AI_FALLBACK_TIMEOUT_MS", DEFAULTS.fallbackTimeoutMs),
  };
}
