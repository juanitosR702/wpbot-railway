// Catálogo de comandos para la IA.
//
// La fuente de verdad de QUÉ comandos existen es Router.getCommands(); este
// archivo solo añade metadatos (descripción, uso, nivel, palabras clave) que el
// modelo consulta bajo demanda con `buscar_comandos` / `ver_comando`.
//
// Regla de oro: si un comando no está en INFO se asume nivel `user` y sin
// descripción. Nunca se inventa un comando que el router no haya registrado.

export const LEVEL = Object.freeze({
  USER: "user",
  ADMIN: "admin",
  CREATOR: "creator",
});

const U = LEVEL.USER;
const A = LEVEL.ADMIN;
const C = LEVEL.CREATOR;

// Comandos internos que la IA no debe poder disparar.
const IGNORED = new Set(["bench"]);

const INFO = {
  // ---- Base ----
  ping: { desc: "Comprueba que el bot está vivo y mide la latencia", level: U, keywords: ["ping", "latencia", "vivo"] },
  status: { desc: "Estado del bot: WhatsApp, MongoDB y tiempo activo", level: U, keywords: ["estado", "salud", "uptime"] },
  hola: { desc: "Saludo con menciones a todo el grupo", level: U, keywords: ["hola", "saludo"] },
  echo: { desc: "Repite el texto que le pases", usage: "!echo <texto>", level: U, keywords: ["repite", "echo"] },
  info: { desc: "Muestra tus datos de teléfono, nombre y grupo", level: U, keywords: ["mis datos", "info"] },
  help: { desc: "Menú con todos los comandos disponibles", level: U, keywords: ["ayuda", "menu", "comandos"] },

  // ---- IA ----
  ai: { desc: "Pregunta libre a la IA (también puedes mencionar al bot con @)", usage: "!ai <pregunta>", level: U, keywords: ["pregunta", "ia"] },
  ia: { desc: "Alias de !ai", usage: "!ia <pregunta>", level: U, keywords: ["pregunta", "ia"] },
  ask: { desc: "Alias de !ai", usage: "!ask <pregunta>", level: U, keywords: ["pregunta", "ia"] },
  resume: { desc: "Resume las últimas 24h del chat", level: U, keywords: ["resumen", "resume"] },
  resumen: { desc: "Alias de !resume", level: U, keywords: ["resumen"] },
  aireset: { desc: "Borra el historial de la IA en este chat", level: U, keywords: ["borrar historial ia"] },
  aistatus: { desc: "Estado del módulo de IA", level: U, keywords: ["estado ia"] },

  // ---- Administración del grupo ----
  close: { desc: "Cierra el grupo: solo admins pueden escribir", level: A, keywords: ["cierra", "cerrar", "solo admins"] },
  open: { desc: "Abre el grupo para que todos puedan escribir", level: A, keywords: ["abre", "abrir", "todos escriben"] },
  kickwarning: { desc: "Expulsa a quien tenga advertencias acumuladas", level: A, keywords: ["expulsa advertidos", "saca advertidos"], destructive: true, groupOnly: true },
  antinsfw: { desc: "Controla el filtro anti-NSFW (on/off/status/mode/block/unblock/blocklist)", usage: "!antinsfw on|off|status|mode|block|unblock|blocklist", level: A, keywords: ["nsfw", "contenido", "porno", "filtro", "imagenes"], destructive: true },
  kick: {
    desc: "Expulsa a un miembro del grupo",
    usage: "!kick [@usuario|numero]",
    level: A,
    keywords: ["elimina", "eliminar", "expulsa", "expulsar", "saca", "sacar", "kick", "bota", "botar", "quita", "remueve"],
    destructive: true,
    needsTarget: true,
  },
  kirkrandom: { desc: "Expulsa a un miembro al azar (ruleta)", level: A, keywords: ["expulsa al azar", "ruleta"], destructive: true, groupOnly: true },
  add: { desc: "Añade a alguien por número de teléfono", usage: "!add <numero>", level: A, keywords: ["agrega", "añade", "invita"], needsTarget: true },
  promote: { desc: "Hace admin a un miembro", level: A, keywords: ["asciende", "promueve", "haz admin"], destructive: true, needsTarget: true },
  demote: { desc: "Quita el admin a un miembro", level: A, keywords: ["degrada", "quita admin"], destructive: true, needsTarget: true },
  link: { desc: "Devuelve el enlace de invitación del grupo", level: A, keywords: ["link", "enlace", "invitacion"] },
  resetlink: { desc: "Revoca el enlace y genera uno nuevo", level: A, keywords: ["nuevo link", "revoca enlace"], destructive: true },
  bot: { desc: "Enciende o apaga el bot en este grupo", usage: "!bot on|off", level: A, keywords: ["apaga el bot", "enciende el bot", "desactiva el bot"], destructive: true },
  modulo: { desc: "Activa o desactiva un módulo en este grupo (economía, casino, ia...)", usage: "!modulo on|off <modulo>", level: A, keywords: ["desactiva economia", "activa modulo", "modulos del grupo"], destructive: true },
  modulos: { desc: "Muestra el menú numerado de módulos para activarlos o desactivarlos", level: A, keywords: ["modulos", "funciones del grupo", "menu"] },

  // ---- Fichas de ingreso ----
  ficha: { desc: "Rellena la ficha de ingreso del grupo paso a paso (menú desplegable)", level: U, keywords: ["ficha", "formulario", "ingreso", "registro", "unirme", "solicitud"], groupOnly: true },
  setficha: {
    desc: "Configura la ficha de ingreso del grupo. Con `importar` se pega la ficha completa de una vez (marcadores ENCABEZADO:, CAMPOS, PIE:; dentro, '# SECCION', 'Campo | op1, op2', 'Campo'). En CAMPOS solo van preguntas: las reglas y avisos van al PIE, no como campos",
    usage: "!setficha importar <ficha> | !setficha ver | !setficha dragon | !setficha reset",
    level: A,
    keywords: ["configurar ficha", "pegar ficha", "cargar ficha", "crear formulario", "formulario de admisión", "preguntas de ingreso", "ghost dragons"],
    groupOnly: true,
    destructive: true,
    multiline: true,
    maxChars: 2000,
  },
  lobby: {
    desc: "Configura el flujo lobby→general y sus filtros de admisión en una sola orden: edad mínima, países permitidos, iniciales del nombre y excusa cuando no cumple",
    usage: "!lobby filtros edad=18; paises=Colombia, México; iniciales=A M; excusa=Estamos llenos  |  !lobby ver | on | off | aqui lobby | aqui general | demora <s>",
    level: A,
    keywords: ["lobby", "admisión", "admission", "filtros", "edad mínima", "solo mayores", "países permitidos", "iniciales", "excusa", "cupo lleno", "grupo general"],
    groupOnly: true,
  },
  rutas: { desc: "Reparte las fichas a varios grupos según sus datos (edad, país, etc.)", usage: "!rutas [ver | aqui <nombre> campo=valor | quitar <nombre> | limpiar]", level: A, keywords: ["rutas fichas", "repartir fichas", "grupos por edad", "destino fichas"], groupOnly: true, destructive: true },
  fichadestino: { desc: "Marca este grupo (o un JID) como almacén de fichas", usage: "!fichadestino [off|ver]", level: A, keywords: ["grupo fichas", "almacen fichas", "destino fichas"], groupOnly: true, destructive: true },
  tagall: { desc: "Menciona a todos los participantes", level: A, keywords: ["menciona a todos", "tag all", "avisa a todos"] },
  hidetag: { desc: "Menciona a todos sin mostrar el listado", level: A, keywords: ["menciona invisible", "hidetag"] },
  mutechat: { desc: "Silencia el grupo: solo admins usan comandos", level: A, keywords: ["silencia grupo", "mute grupo"] },
  unmutechat: { desc: "Quita el silencio del grupo", level: A, keywords: ["activa grupo", "unmute grupo"] },
  antilink: { desc: "Activa/desactiva el borrado de enlaces", usage: "!antilink on|off", level: A, keywords: ["antilink", "bloquea enlaces"] },
  welcome: { desc: "Activa/desactiva el mensaje de bienvenida", usage: "!welcome on|off", level: A, keywords: ["bienvenida"] },
  setwelcome: { desc: "Define el mensaje de bienvenida ({user})", usage: "!setwelcome <texto>", level: A, keywords: ["mensaje bienvenida"] },
  setbye: { desc: "Define el mensaje de despedida ({user})", usage: "!setbye <texto>", level: A, keywords: ["mensaje despedida"] },
  warn: { desc: "Da una advertencia a un miembro", level: A, keywords: ["advierte", "warning"], needsTarget: true },
  warnings: { desc: "Muestra las advertencias de un miembro", level: A, keywords: ["advertencias", "warns"], needsTarget: true },
  clearwarns: { desc: "Borra las advertencias de un miembro", level: A, keywords: ["limpia advertencias"], needsTarget: true },

  // ---- Moderación ----
  mute: { desc: "Silencia a un usuario (no puede escribir)", level: A, keywords: ["silencia", "mutea", "mute"], destructive: true, needsTarget: true },
  unmute: { desc: "Devuelve el habla a un usuario", level: A, keywords: ["desilencia", "unmute"], needsTarget: true },
  blacklist: { desc: "Bloquea a un usuario del bot", level: A, keywords: ["banea", "ban", "bloquea", "blacklist"], destructive: true, needsTarget: true },
  unblacklist: { desc: "Quita el bloqueo de un usuario", level: A, keywords: ["desbanea", "desbloquea"], needsTarget: true },
  del: { desc: "Borra el mensaje citado", level: A, keywords: ["borra mensaje", "elimina mensaje"], destructive: true },
  delme: { desc: "Borra tu propio mensaje", level: U, keywords: ["borra mi mensaje"] },
  modlogs: { desc: "Historial de moderación del grupo", level: A, keywords: ["historial moderacion", "logs"] },

  // ---- Creador ----
  creador: { desc: "Muestra quién es el creador del bot", level: U, keywords: ["creador", "dueño"] },
  owner: { desc: "Alias de !creador", level: U, keywords: ["dueño"] },
  ownerid: { desc: "Lista los JIDs del remitente (diagnóstico)", level: C, keywords: ["ids", "jids"] },
  ownerprotect: { desc: "Resumen del sistema de protección", level: C, keywords: ["protegidos", "proteccion"] },
  protect: { desc: "Protege a un usuario de moderación", usage: "!protect <@usuario|numero>", level: C, keywords: ["protege"], needsTarget: true },
  proteger: { desc: "Alias de !protect", level: C, keywords: ["protege"], needsTarget: true },
  unprotect: { desc: "Quita la protección a un usuario", level: C, keywords: ["desprotege"], needsTarget: true },
  desproteger: { desc: "Alias de !unprotect", level: C, keywords: ["desprotege"], needsTarget: true },
  protected: { desc: "Lista los usuarios protegidos", level: C, keywords: ["protegidos"] },
  protegidos: { desc: "Alias de !protected", level: C, keywords: ["protegidos"] },
  botuptime: { desc: "Tiempo activo del proceso", level: C, keywords: ["uptime"] },
  salirgrupo: { desc: "Hace que el bot abandone el grupo", level: C, keywords: ["sale del grupo", "abandona grupo"], destructive: true },
  leavegroup: { desc: "Alias de !salirgrupo", level: C, keywords: ["sale del grupo"], destructive: true },
  botoff: { desc: "Apaga el proceso del bot", level: C, keywords: ["apaga el bot", "detente"], destructive: true },
  apagarbot: { desc: "Alias de !botoff", level: C, keywords: ["apaga el bot"], destructive: true },
  darcoins: { desc: "Regala coins a un usuario", usage: "!darcoins <cantidad> [@usuario]", level: C, keywords: ["da coins", "regala monedas", "da dinero"], destructive: true },
  givemoney: { desc: "Alias de !darcoins", level: C, keywords: ["da dinero"], destructive: true },
  addmoney: { desc: "Alias de !darcoins", level: C, keywords: ["da dinero"], destructive: true },

  // ---- Economía ----
  balance: { desc: "Muestra tu saldo de coins", level: U, keywords: ["saldo", "dinero", "coins"] },
  bal: { desc: "Alias de !balance", level: U, keywords: ["saldo"] },
  daily: { desc: "Reclama la recompensa diaria", level: U, keywords: ["diario", "recompensa"] },
  work: { desc: "Trabaja para ganar coins", level: U, keywords: ["trabaja", "gana"] },
  crime: { desc: "Intenta un delito por coins (riesgo)", level: U, keywords: ["delito", "crimen"], destructive: true },
  rob: { desc: "Intenta robar coins a alguien", level: U, keywords: ["roba", "robar"], destructive: true, needsTarget: true },
  fish: { desc: "Pesca para ganar coins", level: U, keywords: ["pesca"] },
  hunt: { desc: "Caza para ganar coins", level: U, keywords: ["caza"] },
  mine: { desc: "Mina para ganar coins", level: U, keywords: ["mina"] },
  steal: { desc: "Intenta robar a otro usuario", level: U, keywords: ["roba"], destructive: true, needsTarget: true },
  scratch: { desc: "Rasca un boleto por coins", level: U, keywords: ["rasca", "boleto"] },
  deposit: { desc: "Deposita coins en el banco", usage: "!deposit <cantidad>", level: U, keywords: ["deposita", "banco"] },
  dep: { desc: "Alias de !deposit", level: U, keywords: ["deposita"] },
  withdraw: { desc: "Retira coins del banco", usage: "!withdraw <cantidad>", level: U, keywords: ["retira", "saca del banco"] },
  wd: { desc: "Alias de !withdraw", level: U, keywords: ["retira"] },
  transfer: { desc: "Transfiere coins a otro usuario", usage: "!transfer <cantidad> [@usuario]", level: U, keywords: ["transfiere", "envia coins"], destructive: true, needsTarget: true },
  pay: { desc: "Alias de !transfer", level: U, keywords: ["paga", "transfiere"], destructive: true, needsTarget: true },
  shop: { desc: "Muestra la tienda", level: U, keywords: ["tienda"] },
  buy: { desc: "Compra un artículo de la tienda", usage: "!buy <articulo>", level: U, keywords: ["compra"] },
  inventory: { desc: "Muestra tu inventario", level: U, keywords: ["inventario"] },
  inv: { desc: "Alias de !inventory", level: U, keywords: ["inventario"] },

  // ---- Casino ----
  blackjack: { desc: "Juega blackjack apostando coins", usage: "!blackjack <apuesta>", level: U, keywords: ["blackjack", "21"], destructive: true },
  coinflip: { desc: "Apuesta a cara o cruz", usage: "!coinflip <apuesta>", level: U, keywords: ["cara o cruz", "moneda"], destructive: true },
  dice: { desc: "Apuesta a los dados", usage: "!dice <apuesta>", level: U, keywords: ["dados"], destructive: true },
  roulette: { desc: "Juega a la ruleta", usage: "!roulette <apuesta>", level: U, keywords: ["ruleta"], destructive: true },
  slots: { desc: "Juega a las tragamonedas", usage: "!slots <apuesta>", level: U, keywords: ["tragamonedas", "slots"], destructive: true },
  hit: { desc: "Pide otra carta en blackjack", level: U, keywords: ["pide carta", "hit"] },
  stand: { desc: "Te plantas en blackjack", level: U, keywords: ["me planto", "stand"] },

  // ---- Niveles ----
  level: { desc: "Tu nivel y experiencia en el grupo", level: U, keywords: ["nivel", "xp"] },
  rank: { desc: "Tu posición en el ranking del grupo", level: U, keywords: ["rango", "posicion"] },
  ranking: { desc: "Top de niveles del grupo", level: U, keywords: ["tabla", "top niveles"] },
  top: { desc: "Los usuarios con más actividad", level: U, keywords: ["top", "mejores"] },
  aura: { desc: "Muestra tu aura o la de otro", level: U, keywords: ["aura"] },

  // ---- Multimedia ----
  sticker: { desc: "Convierte una imagen/video en sticker", level: U, keywords: ["sticker", "figurita"] },
  s: { desc: "Alias de !sticker", level: U, keywords: ["sticker"] },
  stiker: { desc: "Alias de !sticker", level: U, keywords: ["sticker"] },
  tiktoksticker: { desc: "Convierte un video de TikTok en sticker", usage: "!tiktoksticker <url>", level: U, keywords: ["tiktok", "sticker"] },
  toimage: { desc: "Convierte un sticker en imagen", level: U, keywords: ["imagen", "sticker a imagen"] },
  img: { desc: "Busca o genera una imagen", usage: "!img <texto>", level: U, keywords: ["imagen", "foto"] },
  song: { desc: "Descarga una canción de YouTube", usage: "!song <nombre|url>", level: U, keywords: ["musica", "cancion", "descarga"] },
  music: { desc: "Alias de !song", level: U, keywords: ["musica"] },
  musica: { desc: "Alias de !song", level: U, keywords: ["musica"] },

  // ---- Utilidades ----
  poll: { desc: "Crea una encuesta con opciones", usage: "!poll <pregunta>|<opcion1>|<opcion2>", level: U, keywords: ["encuesta", "votacion"] },
  encuesta: { desc: "Alias de !poll", level: U, keywords: ["encuesta"] },
  server: { desc: "Muestra el servidor de Minecraft del grupo", level: U, keywords: ["minecraft", "servidor"] },
  setserver: { desc: "Asistente para configurar el servidor de Minecraft", level: U, keywords: ["configura minecraft"] },
  cancelserver: { desc: "Cancela la configuración de Minecraft en curso", level: U, keywords: ["cancela minecraft"] },
};

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^[!/]+/, "")
    .trim();
}

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9@]+/)
    .filter((token) => token.length > 1);
}

export function createCommandCatalog(router) {
  const byName = new Map();

  for (const item of router.getCommands()) {
    const name = String(item.command || "").replace(/^[!/]+/, "").split(/\s+/)[0].toLowerCase();
    if (!name || IGNORED.has(name) || byName.has(name)) continue;

    const info = INFO[name] || {};
    byName.set(name, {
      name,
      category: item.category || "General",
      desc: info.desc || "",
      usage: info.usage || `!${name}`,
      level: info.level || LEVEL.USER,
      keywords: info.keywords || [],
      destructive: Boolean(info.destructive),
      needsTarget: Boolean(info.needsTarget),
      groupOnly: Boolean(info.groupOnly),
      multiline: Boolean(info.multiline),
      maxChars: Number(info.maxChars) || 0,
    });
  }

  function names() {
    return [...byName.keys()];
  }

  function get(name) {
    return byName.get(normalize(name)) || null;
  }

  function byCategory() {
    const groups = new Map();
    for (const entry of byName.values()) {
      if (!groups.has(entry.category)) groups.set(entry.category, []);
      groups.get(entry.category).push(entry.name);
    }
    return groups;
  }

  function score(entry, tokens, raw) {
    const name = normalize(entry.name);
    let total = 0;
    if (name === raw) total += 120;
    for (const token of tokens) {
      if (name === token) total += 60;
      else if (name.startsWith(token)) total += 35;
      else if (name.includes(token)) total += 20;

      if (entry.keywords.some((keyword) => normalize(keyword).includes(token))) total += 22;
      if (normalize(entry.desc).includes(token)) total += 8;
      if (normalize(entry.category).includes(token)) total += 4;
    }
    return total;
  }

  function search(query, limit = 5) {
    const raw = normalize(query);
    const tokens = tokenize(query);
    if (!tokens.length) return [];

    return [...byName.values()]
      .map((entry) => ({ entry, points: score(entry, tokens, raw) }))
      .filter((item) => item.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, Math.max(1, Math.min(10, limit)))
      .map((item) => item.entry);
  }

  // Índice compacto de solo nombres, para proveedores sin function calling.
  function compactIndex() {
    return [...byCategory().entries()]
      .map(([category, list]) => `${category}: ${list.join(", ")}`)
      .join("\n");
  }

  return { names, get, byCategory, search, compactIndex, size: () => byName.size };
}
