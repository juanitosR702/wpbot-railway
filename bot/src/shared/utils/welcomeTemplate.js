// Variables de las plantillas de bienvenida/despedida.
//
// Se renderizan al enviar el mensaje (no al configurarlo) para que el nombre
// del grupo y el total de participantes estén siempre al día.

export const WELCOME_VARS_HELP = [
  "*Variables disponibles:*",
  "• @user — etiqueta a la persona que entra o sale (también sirve {user})",
  "• {group} — nombre del grupo",
  "• {count} — número de participantes",
].join("\n");

const USER_TOKEN = /\{user\}|@user\b/gi;
const GROUP_TOKEN = /\{group\}|@group\b/gi;
const COUNT_TOKEN = /\{count\}|\{total\}/gi;

export function renderWelcomeTemplate(template, vars = {}) {
  const user = vars.user || "@usuario";
  const group = vars.group || "el grupo";
  const count = vars.count === undefined || vars.count === null ? "" : String(vars.count);

  return String(template || "")
    // Reemplazo por función: los nombres pueden contener "$&" y romper el
    // reemplazo por string.
    .replace(USER_TOKEN, () => user)
    .replace(GROUP_TOKEN, () => group)
    .replace(COUNT_TOKEN, () => count);
}
