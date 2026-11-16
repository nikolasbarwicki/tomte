# 01: Channel interface and link by one-time code

**What to build:** The host gets a `channels` feature module with the channel interface and the link, and a Channels page in the web UI. This is the tracer bullet: with a fake channel adapter, I create a one-time code on the page, "send" it as that channel's account, and the host links the account and replies; messages from any other account change nothing and get no reply. No Telegram yet. See the spec sections "The channel interface" and "The channel link".

New files: `packages/host/src/channels/index.ts` (interface and registry), a private store for the two tables, `packages/host/src/host-server/api/channels.ts`, and `packages/web/features/channels/` (`api.ts`, `channels.tsx`, `index.ts`). The shapes below are the contract between this ticket and the adapter in ticket 02; names may change in review, the three duties (send, edit, route an inbound update back) may not.

```ts
interface Channel {
  readonly kind: string; // "telegram"
  start(): void;
  stop(): Promise<void>;
  send(to: Account, message: ChannelMessage): Promise<MessageRef>;
  edit(ref: MessageRef, message: ChannelMessage): Promise<void>;
}
type Account = { id: string; label: string };
type ChannelMessage = {
  text: string;
  buttons?: { label: string; data: string }[][];
  link?: { label: string; url: string };
};
type Inbound = {
  from: Account;
  text?: string;
  button?: { data: string; on: MessageRef };
  replyTo?: MessageRef;
};
type Reply = {
  toast?: string;
  send?: ChannelMessage[];
  edit?: { ref: MessageRef; message: ChannelMessage }[];
};
// Channels.receive(kind: string, inbound: Inbound): Promise<Reply>
```

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] A schema step in `platform/db.ts` (append `SCHEMA_V14`, or the next free number; do not edit an earlier step and keep `PRAGMA user_version` in step) adds `channel_links` (one row per channel: account id, label, linked at) and `channel_link_codes` with its failure count. Only a digest of a code is stored
- [x] `/api/channels/link-code` (body `{channel}`) returns a new code in groups of four, valid 10 minutes and once. `/api/channels/list` returns each registered channel with its link (account label and time, or none). `/api/channels/unlink` deletes the link. All three are device-authenticated and dispatched by the `/api/channels/` prefix in `host-server/api/index.ts`, like `/api/devices/`. Request and response shapes are Zod schemas in `packages/contract/src/api.ts`
- [x] `Channels.receive` takes the link code from a plain message or from `/start <code>`, ignoring case, separators and spaces. A valid code links the sender's account, replaces any earlier link for that channel, and returns a short confirmation reply. A used, expired or unknown code is refused with a short reply
- [x] 10 failed code attempts invalidate every outstanding code for the channel, as for pairing codes (`device-auth/index.ts`). Creating a new code restarts the count
- [x] An update from an account that is not linked, whose text is not code-shaped, gets no reply, reaches nothing and is not counted as a failed attempt. Tests prove the reply list is empty, no row changes and the answer path is not called
- [x] An update from the linked account is passed on to a handler registered by later tickets (a stub that returns an empty reply for now), and calls the `onActivity` collaborator once, so feature 13's absence pause can count it
- [x] The composition root constructs `Channels` and passes it its collaborators as arguments (database, `onActivity`); the module imports no other feature (dependency-cruiser stays green, new folder added to `.dependency-cruiser.cjs` if it needs to be private)
- [x] `Channels` can send a message to the linked account of a channel (`send`, returning the adapter's `MessageRef`) and edit one (`edit`); sending with no link is a no-op that reports it
- [x] A Channels page at `/channels` (route in `app/router.tsx`, entry in `app/app-sidebar.tsx` beside Devices) lists the channels, shows the link or "Not linked", has a "Link account" button that opens a dialog copied from `PairingCodeDialog` in `features/devices/devices.tsx` (code, copy button, "works once, expires in 10 minutes") and an Unlink button behind `confirmAction`. The feature imports no other web feature (ADR-0004)
- [x] Host seam tests with a fake channel cover all of the above (prior art: `device-auth/device-auth.test.ts`, `host-server/devices.test.ts`). The page is checked in the browser smoke of ticket 02, which has a host to drive it against. `bun run check` passes
