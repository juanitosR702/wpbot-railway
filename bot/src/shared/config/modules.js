// Módulos que se pueden activar o desactivar por grupo.
//
// `plugin` es el nombre con el que el router registra el plugin
// (`registerPlugin`) y es lo que se guarda en `disabledModules`.
// `key` es el nombre corto que se escribe en el comando.

export const GROUP_MODULES = [
  { key: "administracion", plugin: "group_admin", label: "Administración" },
  { key: "economia", plugin: "economy", label: "Economía" },
  { key: "casino", plugin: "casino", label: "Casino" },
  { key: "niveles", plugin: "levels", label: "Niveles" },
  { key: "stickers", plugin: "stickers", label: "Stickers" },
  { key: "tiktok", plugin: "tiktoksticker", label: "TikTok a sticker" },
  { key: "ia", plugin: "ai", label: "IA" },
  { key: "moderacion", plugin: "moderation", label: "Moderación" },
  { key: "antinsfw", plugin: "anti_nsfw", label: "Anti-NSFW" },
  { key: "encuestas", plugin: "polls", label: "Encuestas" },
  { key: "musica", plugin: "song", label: "Música" },
  { key: "imagen", plugin: "toimage", label: "Sticker a imagen" },
  { key: "fichas", plugin: "fichas", label: "Fichas de ingreso" },
  { key: "lobby", plugin: "lobby", label: "Lobby automático" },
  { key: "minecraft", plugin: "minecraft", label: "Minecraft" },
  { key: "utilidades", plugin: "core-commands", label: "Utilidades" },
  { key: "ayuda", plugin: "help", label: "Ayuda" },
];

// Estos comandos siguen funcionando aunque el bot esté apagado o el módulo de
// administración desactivado: si no, no habría forma de volver a encenderlo.
export const GROUP_CONFIG_COMMANDS = ["bot", "modulo", "modulos"];

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// Acepta la clave corta ("economia"), el nombre del plugin ("economy") o la
// etiqueta ("Economía").
export function resolveModule(value) {
  const wanted = normalize(value);
  if (!wanted) return null;
  return (
    GROUP_MODULES.find((module) => normalize(module.key) === wanted) ||
    GROUP_MODULES.find((module) => normalize(module.plugin) === wanted) ||
    GROUP_MODULES.find((module) => normalize(module.label) === wanted) ||
    null
  );
}

export function moduleLabel(plugin) {
  return GROUP_MODULES.find((module) => module.plugin === plugin)?.label || plugin;
}
