# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**BandalandBot** is a WhatsApp bot built on [Baileys v6](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web automation), written in plain ES modules (no TypeScript, no build step). It uses a layered/plugin architecture: incoming messages flow through a central `Router`, which dispatches to a chain of registered command plugins.

There is no Python/FastAPI component. `bridge/` only holds the Baileys auth session (`bridge/auth/`), created at runtime and not committed.

## Setup & Running

```bash
cd bot
npm install --legacy-peer-deps   # required: peer dep conflicts otherwise
npm run dev                      # or: npm start — both run node src/index.js
```

- `.env` lives at the **repo root** (not `bot/.env`). It's read by `bot/src/shared/config/env.js`, which checks `process.env` → `.env` → `../.env` (relative to `bot/`), cached after first read. See `bot/.env.example` for the full var list.
- **MongoDB is required** — `MONGODB_URI` / `MONGODB_DB`. All persistent plugin state (economy, levels, moderation, anti-NSFW, owner list, minecraft, AI history) lives in MongoDB via `BaseStore`, one collection per store, not on disk.
- **FFmpeg** and **yt-dlp** must be installed locally for stickers/audio (both are provisioned in the Docker image; see `Dockerfile`).
- `bot/index.js` is a one-line legacy shim (`import "./src/index.js"`) — the real entry point is `bot/src/index.js` → `bot/src/app/bootstrap.js`.

**Deploy:** Railway, `Dockerfile`-based build (`railway.json`). Push to `juan-dev` triggers auto-redeploy, or `railway up --service bot-whatsapp`. The Railway volume mounts at `/app/bridge/auth` for session persistence. There's also a `cobalt` service (`ghcr.io/imputnet/cobalt`) used internally by the YouTube downloader for IP-unblocked downloads — see `COBALT_URL`.

## Architecture

Code lives under `bot/src/`, organized in loose Clean-Architecture-style layers:

```
bot/src/
├── app/bootstrap.js          # Wires everything: connection, router, plugin registration, QR HTTP server
├── domain/                   # Pure policy logic (e.g. users/ownerPolicy.js — creator/protected-JID checks)
├── infrastructure/           # Concrete implementations
│   ├── bot/connection.js     # Baileys socket wrapper: auth, reconnect/backoff, presence loop, message events
│   ├── database/             # MongoDB client (connection.js) + BaseStore base class
│   ├── storage/              # Per-feature stores extending BaseStore (economyStore, moderationStore, ...)
│   ├── nsfw/                 # NSFW detection providers
│   ├── stickers/              # sharp (static) + ffmpeg (animated/gif) sticker processing
│   ├── youtube/downloader.js # yt-dlp search + cobalt download for !song
│   ├── ai/                   # Gemini/OpenAI clients for the AI plugin
│   └── users/ownerStorage.js # Creator/bot-number JID lists
├── interfaces/
│   ├── bot/router.js         # Command router (see below)
│   └── commands/<name>/      # One plugin per feature: ai, antiNsfw, casino, economy, groupAdmin,
│                              # help, levels, minecraft, moderation, owner, polls, song, stickers,
│                              # tiktoksticker, toimage
└── shared/                   # config/env.js, config/paths.js, utils/jid.js, messages.js
```

### Router (`interfaces/bot/router.js`)

- Parses `<prefix>command arg1 arg2` (prefix from `PREFIX` env, default `!`).
- Plugins call `router.registerPlugin(plugin)`; each plugin's `register(api)` calls `api.register(handler, meta)` one or more times. `meta.commands` feeds the `!help` listing (grouped by `meta.category`).
- On every message, builds a `context` object (`phone`, `sender`, `text`, `command`, `args`, `isGroup`, `mediaType`, plus bound service methods like `ctx.sendMessage()`, `ctx.reply()`, `ctx.getGroupMetadata()`, `ctx.downloadMedia()`) and runs handlers **in registration order** — the first handler to return a truthy reply wins and short-circuits the rest.
- A handler can return the exported `HALT` sentinel to swallow a message (stop later plugins from acting) without sending any reply — used e.g. by moderation to consume a message it already deleted.
- Handler exceptions are caught per-plugin and logged (`[router] Error en <plugin>:`); they never crash the bot or block other plugins.
- `_unwrapMessage` peels ephemeral/view-once/edited/document-caption wrappers before extracting text or media type, so all downstream code sees plain `conversation`/`imageMessage`/etc.

### Plugin pattern

```javascript
export const myPlugin = {
  name: "my-plugin",
  version: "1.0.0",
  register(router) {
    router.register(async (ctx) => {
      if (!ctx.isCommand || ctx.command !== "mycommand") return null;
      return "reply text";
    }, { category: "UTILIDADES", commands: ["mycommand"] });
  },
};
```
Register the new plugin in `bot/src/app/bootstrap.js` (import + `router.registerPlugin(myPlugin)`).

### Persistence (`infrastructure/database/baseStore.js`)

Every store subclasses `BaseStore(collectionName)`, keeps one MongoDB document per collection (`_id: "state"`), and overrides `_defaultState()` (and optionally `_load()` for migration/merge logic, as `economyStore.js` does for JID de-duplication). Call `await store.ready()` before reading `store.state`, and `await store.save()` after mutating it.

### Bootstrap responsibilities (`app/bootstrap.js`)

- Builds the `Connection` (auth path `../../bridge/auth`, i.e. repo-root `bridge/auth`) and `Router`, then registers all plugins in order.
- Runs a minimal `http` server with the token-gated QR viewer: `GET /qr?token=<QR_ACCESS_TOKEN>` (HTML page in `interfaces/web/qrPage.js`, auto-refreshes every 3 s), `GET /qr.png?token=...` (raw PNG) and `GET /qr/status?token=...` (JSON state consumed by the page). Constant-time compare via `crypto.timingSafeEqual`; 503 without token, 404 with a wrong one.
- Re-forwards view-once media (image/video) back into the chat before routing.
- Wires `group-participants.update` for both welcome/bye messages (`groupAdmin` plugin) and auto-promotion (`shared/utils/autoPromote.js`).
- On `SIGINT`, disconnects cleanly.

### Connection (`infrastructure/bot/connection.js`)

Wraps `makeWASocket`: multi-file auth state, reconnect with reason-specific backoff (`loggedOut`/`forbidden` wipes auth and re-shows QR; `restartRequired` retries in 10s; timeouts back off up to 15–30s), a 5-minute presence-update loop while connected, and a console filter that suppresses noisy Signal-session log spam.

### NSFW providers (`infrastructure/nsfw/nsfwProvider.js`)

`NSFW_PROVIDER` selects one of: `disabled` (default), `gemini`, `openai`, `openrouter`, `local` (HSV heuristic via sharp, no network), `sightengine`, `nudenet`, `custom`. Each normalizes to a `{ score, details }` shape checked against `NSFW_THRESHOLD`.

## Key Conventions

- **JIDs**: use `bot/src/shared/utils/jid.js` — `cleanJid()` strips `@server`/`:device`, `sameParticipant()`/`findParticipant()` compare across phone/LID identities, `resolvePhoneJid()` resolves any identifier to a mentionable phone JID via group metadata.
- **Creator/owner checks**: `domain/users/ownerPolicy.js` (`isCreatorJid`, `isProtectedJid`, `isBotAdmin`) reads from `infrastructure/users/ownerStorage.js` (backed by `CREATOR_NUMBERS`/`BOT_NUMBERS` env + stored extra entries).
- Handlers return a string/object reply, `null` to pass to the next handler, or `HALT` to stop the chain silently.
- Log tags follow `[scope] message` (`[cmd]`, `[router]`, `[nsfw]`, `[song]`, `[connection]`, `[autoPromote]`) — keep this pattern when adding logging.
- ES modules throughout (`"type": "module"`); no bundler/transpiler.

## Documentation

- `AGENTS.md` — condensed architecture/ops notes (same audience as this file).
- `docs/song.md` — `!song` plugin flow (yt-dlp search → cobalt download → audio reply).
