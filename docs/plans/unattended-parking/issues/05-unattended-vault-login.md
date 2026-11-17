# 05: Routines sign in with granted vault entries

Superseded: vault removed (`.scratch/remove-credential-vault/`, 2026-11-17).

**What to build:** `browser_login` works in an unattended run. A routine signs in with a vault entry I already granted to that bot, with nobody watching. A first use, or an entry the bot has no grant for, parks for my approval. Today the tool refuses every unattended run, granted or not. See the spec section "Vault".

**Blocked by:** 02

**Status:** done

How it works today. `registerCredentialTools` in `browser/tools/credentials.ts` returns `errorResult(UNATTENDED_MESSAGE)` when `ctx.unattended()`. `BrowserLogin.login` in `browser/login.ts` finds the entry by label; with no grant for the bot it opens the credential approval wait (`ask`), and with a grant it runs `signIn`, which issues a one-time nonce and has the engine fetch the username and password through the credential plugin (`exchange` checks the nonce and `credentials.hasGrant`). The only code that creates a grant is the approval's `onResolve` in `login.ts`; no route or UI grants. So a grant always means I approved its first use. `credentials.revoke` removes one.

- [x] `browser_login` no longer refuses an unattended run. With a grant it signs in exactly as in a chat. Without one it opens the `credential` wait, which carries the run id, so the run parks. The tool returns `waiting_for_user` and the same instruction ("end your turn")
- [x] Answering Allow on that wait creates the grant (as today) and resumes the run with "call browser_login again". Deny resumes it with "do not ask again; report what is blocked". After Allow, the next run signs in with no wait
- [x] Revoking a grant (`credentials.revoke`) makes the next unattended `browser_login` park again
- [x] `needs_another_step` (a code, a passkey) is unchanged: the result tells the bot to call `browser_request_takeover`, which parks (ticket 04)
- [x] The password never reaches the bot, the run output or the chat in an unattended run either: the existing guarantees of `login.test.ts` hold for a run
- [x] Whichever of tickets 04 and 05 lands second removes `UNATTENDED_MESSAGE`, `BrowserToolContext.unattended`, the `unattended` collaborator of `createBrowserEndpoint`, `BrowserOptions.unattended` and the `unattended` argument that `host-server/index.ts` passes to `createBrowser`; after both, nothing in the browser asks whether a turn is attended. The first to land leaves them in place
- [x] `docs/browser.md` (the Routines section and "First use needs your approval") says a routine uses granted entries, parks on a first use, and that a granted entry signs in without me
- [x] Tests (prior art: `browser/login.test.ts`, `browser/routines.test.ts`): a routine with a granted entry signs in, and the fake engine recorded `auth login` for it, with no wait opened; a routine with an ungranted entry parks, Allow creates the grant and resumes the run, and a second run signs in without a wait; revoking the grant parks again; Deny resumes with the denial message; the tests that expected `UNATTENDED_MESSAGE` for `browser_login` are rewritten. Each runs chat-hosted and headless. `bun run check` passes

## Comments

- The behaviour needed almost no code: the `credential` wait already took its run id from `Waits.context(botId)` and `BrowserLogin.login` already parked on a missing grant, so the change is removing the refusal in `registerCredentialTools`. Deny's text is the existing "Do not ask again; continue without it or report what is blocked."
- Cutover: besides the items the ticket lists, `Chats.unattended(botId)` (`host-server/chats.ts`) had no caller left once `index.ts` stopped passing it to `createBrowser`, so it is removed too. The `unattended` hook inside `chats.ts` for `ask_user` and tool approvals (`threads.ts`) stays.
- Tests: the refusal tests in `login.test.ts` and `routines.test.ts` are replaced by `routine sign-in` in `routines.test.ts`, chat-hosted and headless: park and Allow resumes, a second run signs in (engine `auth login` recorded, run ends `succeeded` and never parks), revoke parks again, Deny, `needs_another_step` followed by a takeover that parks, and the password scan (results, messages, run rows, every file under the data root). A routine's first grant is created through the real Allow path, since no route grants.
- Smokes: none needed (no smoke script, UI or fake CLI touched).
