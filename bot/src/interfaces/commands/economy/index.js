import { EconomyStore } from "../../../infrastructure/storage/economyStore.js";
import { MSG } from "../../../shared/messages.js";


const DEFAULT_CONFIG = {
  currencyName: "monedas",
  workCooldownMs: 15 * 60 * 1000,
  dailyCooldownMs: 24 * 60 * 60 * 1000,
  workMin: 25,
  workMax: 95,
  dailyReward: 250,
  huntCooldownMs: 10 * 60 * 1000,
  huntMin: 15,
  huntMax: 60,
  robCooldownMs: 30 * 60 * 1000,
  shop: [
    { id: "pocion", name: "Pocion", price: 150 },
    { id: "escudo", name: "Escudo", price: 300 },
    { id: "vip", name: "Pase VIP", price: 1000 },
    { id: "tarjeta", name: "Tarjeta de Debito", price: 500 },
  ],
};

let sharedStore = null;
let sharedConfig = null;

function getEconomyContext(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  if (!sharedStore) {
    sharedStore = new EconomyStore();
  }
  sharedConfig = config;
  return { config, store: sharedStore };
}

export function getEconomyApi(options = {}) {
  const { config, store } = getEconomyContext(options);

  return {
    balance(groupId, jid) {
      return store.user(groupId, jid).balance;
    },
    money(amount) {
      return money(amount, config);
    },
    settleBet(groupId, jid, amount, payoutMultiplier, meta = {}) {
      const bet = Number.parseInt(amount, 10);
      if (!Number.isFinite(bet) || bet <= 0) {
        return { ok: false, reason: `Esa apuesta no es válida, ingresa un número entero mayor a 0 🎲` };
      }

      const user = store.user(groupId, jid);
      if (user.balance < bet) {
        return { ok: false, reason: `No tienes suficientes ${config.currencyName} para esa apuesta 💸` };
      }

      const payout = Math.floor(bet * payoutMultiplier);
      const profit = payout - bet;
      user.balance += profit;
      store.log({ type: "casino", jid, bet, payout, profit, ...meta });
      store.save();

      return { ok: true, balance: user.balance, payout, profit };
    },
  };
}

function parseTarget(ctx) {
  const info = ctx.raw.message?.extendedTextMessage?.contextInfo;
  const fromMention = info?.mentionedJid?.[0];
  const fromQuote = info?.participant;
  const arg = ctx.args?.[0];
  return fromMention || fromQuote || (arg?.includes("@") ? arg : null);
}

function parseAmount(value) {
  const amount = Number.parseInt(value, 10);
  return Number.isFinite(amount) ? amount : 0;
}

function money(amount, config) {
  return `${amount} ${config.currencyName}`;
}

function remaining(ms) {
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cardPayment(user, amount) {
  const hasCard = (user.inventory?.tarjeta || 0) > 0;
  if (!hasCard) return null;
  const fee = Math.ceil(amount * 0.04);
  const total = amount + fee;
  if ((user.bank || 0) < total) return null;
  user.bank -= total;
  return { fee };
}

function makeHandler(config, store, ownerPolicy) {
  return async (ctx) => {
    await store.ready();
    if (!ctx.isCommand) return null;
    const parts = ctx.args || [];
    const command = ctx.command;
    const metadata = ctx.isGroup ? await ctx.getGroupMetadata().catch(() => null) : null;
    const isCreator = ownerPolicy.isCreatorJid(ctx.sender, metadata);

    if (command === "balance" || command === "bal") {
      const target = parseTarget(ctx) || ctx.sender;
      const user = store.user(ctx.phone, target);
      const card = (user.inventory?.tarjeta || 0) > 0 ? " 💳" : "";
      return `💰 Balance: ${money(user.balance, config)}. 🏦 Banco: ${money(user.bank, config)}.${card}`;
    }

    if (command === "dep" || command === "deposit") {
      const user = store.user(ctx.phone, ctx.sender);
      const amountStr = parts[0];
      let amount;
      if (amountStr === "all") {
        amount = user.balance;
      } else {
        amount = parseAmount(amountStr);
      }
      if (amount <= 0) return "Indica un monto valido para depositar 💰";
      const result = store.transferToBank(ctx.phone, ctx.sender, amount);
      if (!result.ok) return result.reason;
      return `🏦 Depositaste ${money(amount, config)} en el banco. Cartera: ${money(result.wallet, config)}. Banco: ${money(result.bank, config)}.`;
    }

    if (command === "wd" || command === "withdraw") {
      const user = store.user(ctx.phone, ctx.sender);
      const amountStr = parts[0];
      let amount;
      if (amountStr === "all") {
        amount = user.bank;
      } else {
        amount = parseAmount(amountStr);
      }
      if (amount <= 0) return "Indica un monto valido para retirar 💰";
      const result = store.transferFromBank(ctx.phone, ctx.sender, amount);
      if (!result.ok) return result.reason;
      return `🏦 Retiraste ${money(amount, config)} del banco. Cartera: ${money(result.wallet, config)}. Banco: ${money(result.bank, config)}.`;
    }

    if (command === "work") {
      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const lastWork = user.cooldowns.work || 0;
      const wait = config.workCooldownMs - (now - lastWork);

      if (!isCreator && wait > 0) return `⏳ Todavía no puedes trabajar. Vuelve en ${remaining(wait)}.`;

      const reward = randomInt(config.workMin, config.workMax);
      if (!isCreator) user.cooldowns.work = now;
      const balance = store.addBalance(ctx.phone, ctx.sender, reward, "work", { group: ctx.phone });
      return `💼 Trabajaste y ganaste ${money(reward, config)}. Balance actual: ${money(balance, config)}.`;
    }

    if (command === "hunt") {
      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const lastHunt = user.cooldowns.hunt || 0;
      const wait = config.huntCooldownMs - (now - lastHunt);

      if (!isCreator && wait > 0) return `⏳ Todavía no puedes cazar. Vuelve en ${remaining(wait)}.`;

      if (Math.random() < 0.15) {
        if (!isCreator) user.cooldowns.hunt = now;
        store.save();
        return "🌲 No encontraste nada en la cacería... Mejor suerte la próxima vez.";
      }

      const reward = randomInt(config.huntMin, config.huntMax);
      if (!isCreator) user.cooldowns.hunt = now;
      const balance = store.addBalance(ctx.phone, ctx.sender, reward, "hunt", { group: ctx.phone });
      return `🏹 ¡Cazaste y conseguiste ${money(reward, config)}! Balance: ${money(balance, config)}.`;
    }

    if (command === "rob") {
      const target = parseTarget(ctx);
      if (!target) return "Menciona o responde al usuario al que quieres robar 🦹";
      if (target === ctx.sender) return "No puedes robarte a ti mismo 😅";

      const victim = store.user(ctx.phone, target);
      if (victim.balance <= 0) return "Ese usuario no tiene monedas en su cartera 💸";

      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const lastRob = user.cooldowns.rob || 0;
      const wait = config.robCooldownMs - (now - lastRob);

      if (!isCreator && wait > 0) return `⏳ Ya robaste recientemente. Vuelve en ${remaining(wait)}.`;

      if (!isCreator) user.cooldowns.rob = now;

      const stealPct = randomInt(10, 80);
      const stolen = Math.ceil(victim.balance * stealPct / 100);

      victim.balance -= stolen;
      user.balance += stolen;

      store.log({ type: "rob", from: target, to: ctx.sender, amount: stolen, pct: stealPct, group: ctx.phone });
      store.save();

      return `🦹 Robaste ${money(stolen, config)} (${stealPct}%) de ${target.split("@")[0]}. Balance: ${money(user.balance, config)}.`;
    }

    if (command === "darcoins" || command === "givemoney" || command === "addmoney") {
      if (!isCreator) return MSG.SOLO_CREADOR;

      const target = parseTarget(ctx) || ctx.sender;
      const amountArg = target ? parts.find((part) => /^-?\d+$/.test(part)) : parts[0];
      const amount = parseAmount(amountArg);

      if (!target) return "Menciona o responde al usuario al que quieres dar monedas 👤";
      if (amount === 0) return "Indica un monto válido (diferente de 0) 💰";

      const balance = store.addBalance(ctx.phone, target, amount, "creator-grant", { by: ctx.sender, group: ctx.phone });
      return `✅ Listo. Balance actualizado: ${money(balance, config)}.`;
    }

    if (command === "daily") {
      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const lastDaily = user.cooldowns.daily || 0;
      const wait = config.dailyCooldownMs - (now - lastDaily);

      if (wait > 0) return `⏳ Tu recompensa diaria estará lista en ${remaining(wait)}.`;

      user.cooldowns.daily = now;
      const balance = store.addBalance(ctx.phone, ctx.sender, config.dailyReward, "daily", { group: ctx.phone });
      return `🎁 ¡Recibiste tu recompensa diaria! +${money(config.dailyReward, config)}. Balance: ${money(balance, config)}.`;
    }

    if (command === "transfer" || command === "pay") {
      const target = parseTarget(ctx);
      const amountArg = target ? parts.find((part) => /^\d+$/.test(part)) : parts[0];
      const amount = parseAmount(amountArg);

      if (!target) return "Menciona o responde al usuario al que quieres transferir 💸";
      if (target === ctx.sender) return "No puedes transferirte monedas a ti mismo 😅";
      if (amount <= 0) return "Indica un monto válido (mayor a 0) 💰";

      const sender = store.user(ctx.phone, ctx.sender);
      let method = "wallet";

      if (sender.balance >= amount) {
        sender.balance -= amount;
      } else {
        const card = cardPayment(sender, amount);
        if (!card) return "No tienes suficientes fondos en cartera ni en el banco con tarjeta 💳";
        method = "card";
      }

      const receiver = store.user(ctx.phone, target);
      receiver.balance += amount;

      store.log({ type: "transfer", from: ctx.sender, to: target, amount, method });
      store.save();

      if (method === "card") {
        return `💸 Enviaste ${money(amount, config)} con tarjeta (+${money(card.fee, config)} fee). Banco: ${money(sender.bank, config)}.`;
      }
      return `💸 Enviaste ${money(amount, config)}. Tu balance: ${money(sender.balance, config)}.`;
    }

    if (command === "shop") {
      return [
        "🛒 *Tienda*",
        ...config.shop.map((item) => `• ${item.id}: ${item.name} — ${money(item.price, config)}`),
        `\nUsa ${ctx.prefix}buy <id> para comprar.`,
      ].join("\n");
    }

    if (command === "buy") {
      const itemId = parts[0]?.toLowerCase();
      const item = config.shop.find((entry) => entry.id === itemId);

      if (!item) return `No encontré ese item. Usa ${ctx.prefix}shop para ver los disponibles 🛒`;

      const user = store.user(ctx.phone, ctx.sender);
      if (user.balance >= item.price) {
        user.balance -= item.price;
        store.addItem(ctx.phone, ctx.sender, item.id, 1);
        store.log({ type: "buy", jid: ctx.sender, item: item.id, price: item.price, group: ctx.phone, method: "wallet" });
        store.save();
        return `✅ Compraste ${item.name}. Balance: ${money(user.balance, config)}.`;
      }

      const card = cardPayment(user, item.price);
      if (!card) return `No tienes suficientes fondos. Precio: ${money(item.price, config)} 💰`;

      store.addItem(ctx.phone, ctx.sender, item.id, 1);
      store.log({ type: "buy", jid: ctx.sender, item: item.id, price: item.price, fee: card.fee, group: ctx.phone, method: "card" });
      store.save();
      return `✅ Compraste ${item.name} con tarjeta (${money(item.price, config)} + ${money(card.fee, config)} fee). Banco: ${money(user.bank, config)}.`;
    }

    if (command === "inventory" || command === "inv") {
      const target = parseTarget(ctx) || ctx.sender;
      const user = store.user(ctx.phone, target);
      const items = Object.entries(user.inventory);

      if (!items.length) return `No hay ningún item en el inventario todavía 🎒`;

      return [`🎒 *Inventario*`, ...items.map(([itemId, quantity]) => `• ${itemId} ×${quantity}`)].join("\n");
    }

    if (command === "crime") {
      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const last = user.cooldowns.crime || 0;
      const wait = 30 * 60 * 1000 - (now - last);

      if (!isCreator && wait > 0) return `⏳ Espera ${remaining(wait)} para cometer otro crimen.`;

      if (!isCreator) user.cooldowns.crime = now;
      const reward = randomInt(50, 200);
      const balance = store.addBalance(ctx.phone, ctx.sender, reward, "crime", { group: ctx.phone });
      return `🔫 Cometiste un crimen y ganaste ${money(reward, config)}. Balance: ${money(balance, config)}.`;
    }

    if (command === "fish") {
      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const last = user.cooldowns.fish || 0;
      const wait = 10 * 60 * 1000 - (now - last);

      if (!isCreator && wait > 0) return `⏳ Espera ${remaining(wait)} para pescar de nuevo.`;

      if (!isCreator) user.cooldowns.fish = now;
      const reward = randomInt(10, 50);
      const balance = store.addBalance(ctx.phone, ctx.sender, reward, "fish", { group: ctx.phone });
      return `🎣 Pescaste y vendiste el pescado por ${money(reward, config)}. Balance: ${money(balance, config)}.`;
    }

    if (command === "mine") {
      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const last = user.cooldowns.mine || 0;
      const wait = 15 * 60 * 1000 - (now - last);

      if (!isCreator && wait > 0) return `⏳ Espera ${remaining(wait)} para minar de nuevo.`;

      if (!isCreator) user.cooldowns.mine = now;
      const reward = randomInt(20, 80);
      const balance = store.addBalance(ctx.phone, ctx.sender, reward, "mine", { group: ctx.phone });
      return `⛏️ Minaste y encontraste ${money(reward, config)} en minerales. Balance: ${money(balance, config)}.`;
    }

    if (command === "steal") {
      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const last = user.cooldowns.steal || 0;
      const wait = 5 * 60 * 1000 - (now - last);

      if (!isCreator && wait > 0) return `⏳ Espera ${remaining(wait)} para robar carteras de nuevo.`;

      if (!isCreator) user.cooldowns.steal = now;
      const reward = randomInt(5, 30);
      const balance = store.addBalance(ctx.phone, ctx.sender, reward, "steal", { group: ctx.phone });
      return `🫰 Robaste una cartera y conseguiste ${money(reward, config)}. Balance: ${money(balance, config)}.`;
    }

    if (command === "scratch") {
      const user = store.user(ctx.phone, ctx.sender);
      const now = Date.now();
      const last = user.cooldowns.scratch || 0;
      const wait = 60 * 60 * 1000 - (now - last);

      if (!isCreator && wait > 0) return `⏳ Espera ${remaining(wait)} para rascar otra tarjeta.`;

      if (!isCreator) user.cooldowns.scratch = now;
      const reward = randomInt(0, 500);
      const balance = store.addBalance(ctx.phone, ctx.sender, reward, "scratch", { group: ctx.phone });
      return `🎟️ Rascaste tu tarjeta y ganaste ${reward > 0 ? money(reward, config) : "nada :("}. Balance: ${money(balance, config)}.`;
    }

    return null;
  };
}

export const economyPlugin = {
  name: "economy",
  version: "1.0.0",
  register(router, options = {}) {
    const { config, store } = getEconomyContext(options);

    router.register(makeHandler(config, store, options.ownerPolicy), {
      category: "ECONOMIA",
      commands: ["balance", "bal", "work", "hunt", "rob", "daily", "darcoins", "givemoney", "addmoney", "transfer", "pay", "shop", "buy", "inventory", "inv", "dep", "deposit", "wd", "withdraw", "crime", "fish", "mine", "steal", "scratch"],
    });
  },
};
