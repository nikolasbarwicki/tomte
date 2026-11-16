# 05: Routines sign in with granted vault entries

**What to build:** `browser_login` works in an unattended run. A routine signs in with a vault entry I already granted to that bot, with nobody watching. A first use, or an entry the bot has no grant for, parks for my approval. Today the tool refuses every unattended run, granted or not. See the spec section "Vault".

**Blocked by:** 02

**Status:** ready-for-agent

How it works today. `registerCredentialTools` in `browser/tools/credentials.ts` returns `errorResult(UNATTENDED_MESSAGE)` when `ctx.unattended()`. `BrowserLogin.login` in `browser/login.ts` finds the entry by label; with no grant for the bot it opens the credential approval wait (`ask`), and with a grant it runs `signIn`, which issues a one-time nonce and has the engine fetch the username and password through the credential plugin (`exchange` checks the nonce and `credentials.hasGrant`). The only code that creates a grant is the approval's `onResolve` in `login.ts`; no route or UI grants. So a grant always means I approved its first use. `credentials.revoke` removes one.

- [ ] `browser_login` no longer refuses an unattended run. With a grant it signs in exactly as in a chat. Without one it opens the `credential` wait, which carries the run id, so the run parks. The tool returns `waiting_for_user` and the same instruction ("end your turn")
- [ ] Answering Allow on that wait creates the grant (as today) and resumes the run with "call browser_login again". Deny resumes it with "do not ask again; report what is blocked". After Allow, the next run signs in with no wait
- [ ] Revoking a grant (`credentials.revoke`) makes the next unattended `browser_login` park again
- [ ] `needs_another_step` (a code, a passkey) is unchanged: the result tells the bot to call `browser_request_takeover`, which parks (ticket 04)
- [ ] The password never reaches the bot, the run output or the chat in an unattended run either: the existing guarantees of `login.test.ts` hold for a run
- [ ] Whichever of tickets 04 and 05 lands second removes `UNATTENDED_MESSAGE`, `BrowserToolContext.unattended`, the `unattended` collaborator of `createBrowserEndpoint`, `BrowserOptions.unattended` and the `unattended` argument that `host-server/index.ts` passes to `createBrowser`; after both, nothing in the browser asks whether a turn is attended. The first to land leaves them in place
- [ ] `docs/browser.md` (the Routines section and "First use needs your approval") says a routine uses granted entries, parks on a first use, and that a granted entry signs in without me
- [ ] Tests (prior art: `browser/login.test.ts`, `browser/routines.test.ts`): a routine with a granted entry signs in, and the fake engine recorded `auth login` for it, with no wait opened; a routine with an ungranted entry parks, Allow creates the grant and resumes the run, and a second run signs in without a wait; revoking the grant parks again; Deny resumes with the denial message; the tests that expected `UNATTENDED_MESSAGE` for `browser_login` are rewritten. Each runs chat-hosted and headless. `bun run check` passes
