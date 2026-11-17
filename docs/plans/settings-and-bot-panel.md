# Settings screen and bot panel navigation

The app had grown one sidebar entry per admin page (Integrations, Credentials, Devices) plus a theme toggle and the
workspace path squeezed into the sidebar footer, and a bot panel with seven tabs in a 400px column (Work, Tasks, Memory,
Files, Routines, Browser, Settings) where settings, memory and permissions sat in different places and a bot could not be
renamed or given a new face after it was created. This plan replaces both with a structure that has room to grow.

## Information architecture

```
App sidebar
├─ Bots (unchanged rows; context menu: Bot settings, Delete bot)
└─ footer: Integrations (attention badge) · Settings
Settings  /settings/<section>
├─ General        theme (System / Light / Dark), workspace folder
├─ Instructions   instructions for every bot (system prompt), About you (shared user memory)
├─ Models         model providers: Claude (status, how to sign in, models); room for more
├─ Connections    this host (local or remote, address, version), paired devices and pairing codes
├─ Channels       linked phone accounts, Telegram bot token (was /channels)
├─ Credentials    stored logins (was /credentials; removed with the credential vault, 2026-11-17)
└─ About          versions, Claude CLI, browser engine, updates (not yet available)
Bot panel  /bots/<id>?panel=<tab>&section=<page>
├─ Work · Tasks (double-loop only) · Files · Browser   live views, one tab each
└─ Settings        overview → nested pages
   ├─ Profile      name, purpose, avatar
   ├─ Chat & model double-loop switch, model, effort
   ├─ Memory       About you (shared), this bot's directions (both editable)
   ├─ Routines
   ├─ Permissions  always-allowed tools
   └─ Delete bot
```

Integrations stays a top-level destination: it is where tools are connected and it carries an attention badge.
`/credentials`, `/devices` and `/channels` are gone; their content lives under Settings. Links the host sends to a
phone (run notices) open the routines page as `?panel=settings&section=routines`.

The panel keeps a tab only for what changes while the user watches (Work, Tasks, Files, Browser). Everything that
configures the bot moves under one Settings tab with nested pages, so a new per-bot setting adds a row to the overview,
not a tab. The URL carries the page (`section`), so every page is linkable and Back works.

## Contract

`packages/contract/src/api.ts`:

| Route                      | Body                                                                     | Answer                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `/api/bots/profile`        | `BotProfileUpdate` (`botId`, `name`, `purpose`, `face`, `stroke`)        | the bot; 404 for an unknown bot                                                                             |
| `/api/memory/update`       | `MemoryUpdate` (`scope: "user"`, or `scope: "bot"` with `botId`; `text`) | `{ ok: true }`; the new text is streamed as a `memory` event                                                |
| `/api/instructions`        | `{}`                                                                     | `Instructions` (`text`)                                                                                     |
| `/api/instructions/update` | `Instructions`                                                           | `{ ok: true }`                                                                                              |
| `/api/providers`           | `{}`                                                                     | `ModelProviders` (`providers[]`: `id`, `name`, `vendor`, `access`, `status`, `detail`, `connect`, `models`) |

Host behaviour:

- Instructions live in `instructions.md` in the data root and go into every bot's system prompt (standard thread, front,
  worker) under their own heading, after the bot's identity. Empty instructions add nothing.
- The persona (identity and instructions) is computed when a session opens, from the bot as saved on disk, so a rename or
  new instructions reach the next session without a restart. Saving a profile (name or purpose changed), the instructions
  or a memory file reconfigures the affected chats (`chats.reconfigure`): an idle one closes now, a busy one after its
  turn, a front once idle.
- `/api/providers` re-runs `auth status` (one run at a time, bounded) so the Models page shows the sign-in as it is now,
  in local and in remote mode.

## Updates

The About page shows an Updates card that is not wired: no check runs. The desktop app owns updates
(`electron-updater`); exposing its state to the page needs a bridge the sandboxed window does not have (no preload).
The card says so.
