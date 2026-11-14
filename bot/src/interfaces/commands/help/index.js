import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = join(__dirname, "..", "..", "..", "..");

const BANNER_EXTS = /\.(jpe?g|png|webp)$/i;

const CATEGORY_META = {
  IA:             { emoji: "🤖", label: "Inteligencia Artificial" },
  CREADOR:        { emoji: "👑", label: "Creador" },
  ECONOMIA:       { emoji: "💰", label: "Economía" },
  CASINO:         { emoji: "🎰", label: "Casino" },
  STICKERS:       { emoji: "🖼️", label: "Stickers" },
  "ANTI-NSFW":    { emoji: "🔞", label: "Anti-NSFW" },
  ADMINISTRACION: { emoji: "⚙️", label: "Administración" },
  FICHAS:         { emoji: "📋", label: "Fichas" },
  MODERACION:     { emoji: "🛡️", label: "Moderación" },
  NIVELES:        { emoji: "📊", label: "Niveles" },
  UTILIDADES:     { emoji: "🔧", label: "Utilidades" },
  BASE:           { emoji: "🏠", label: "General" },
};

const CATEGORY_ORDER = Object.keys(CATEGORY_META);

function findBanner() {
  const dir = join(BOT_ROOT, "assets");
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => BANNER_EXTS.test(f));
  return file ? readFileSync(join(dir, file)) : null;
}

function groupedCommands(commands) {
  const groups = new Map();
  for (const item of commands) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item.command);
  }
  return groups;
}

function sortedCategories(groups) {
  return [...groups.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function renderMenu(ctx, commands) {
  const groups = groupedCommands(commands);
  const div = "─────────────────────";

  const lines = [
    `╔══════════════════════╗`,
    `║   🤖 *BandalandBot*   ║`,
    `╚══════════════════════╝`,
    ``,
    `👤 *${ctx.name}*`,
    `⌨️  Prefix: \`${ctx.prefix}\`  ·  📡 En línea`,
    div,
  ];

  for (const category of sortedCategories(groups)) {
    const meta = CATEGORY_META[category] || { emoji: "•", label: category };
    const cmds = groups.get(category).map((c) => `\`${ctx.prefix}${c}\``).join("  ");
    lines.push(``, `${meta.emoji} *${meta.label}*`, cmds);
  }

  lines.push(``, div, `_Escribe_ \`${ctx.prefix}<comando>\` _para usarlo_ 🚀`);

  return lines.join("\n");
}

function renderCaption(ctx) {
  return [
    `🤖 *BandalandBot* — Menú de comandos`,
    `👤 ${ctx.name}  ·  ⌨️ Prefix: ${ctx.prefix}`,
    ``,
    `_Escribe_ \`${ctx.prefix}help\` _en el chat para ver el menú completo_ 📋`,
  ].join("\n");
}

export const helpPlugin = {
  name: "help",
  version: "1.0.0",
  register(router) {
    router.register(async (ctx) => {
      if (!ctx.isCommand || ctx.command !== "help") return null;

      const menu = renderMenu(ctx, router.getCommands());
      const banner = findBanner();

      if (banner) {
        return { image: banner, caption: menu };
      }

      return menu;
    }, {
      category: "BASE",
      commands: ["help"],
    });
  },
};
