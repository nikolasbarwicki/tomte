# 04: A takeover parks the run

**What to build:** `browser_request_takeover` works in an unattended run. The run parks with a takeover wait, the bot's Chrome stays open on the page it was on, and when I hand the browser back the run continues in the same session. Today the tool refuses every unattended run with `UNATTENDED_MESSAGE`. See the spec section "Takeover".

**Blocked by:** 02

**Status:** done

How it works today. `registerTakeoverTools` in `browser/tools/takeover.ts` returns `errorResult(UNATTENDED_MESSAGE)` when `ctx.unattended()`. Otherwise `Takeover.request` (`browser/takeover.ts`) opens a wait, calls `browser.holdControl()` and begins control in the `user` phase with an inactivity timer of 30 minutes (`arm`). A hand-back resolves the wait as `done`; the timer resolves it as `timeout`, which counts as Skip. `holdControl` also stops the runtime's idle sweep (`closeIdle` in `browser/runtime.ts`), so Chrome stays open. The web UI opens the live view when a takeover wait arrives (`takeoverId` in `web/features/chat/chat.tsx`), on a phone as the bot panel's sheet.

`UNATTENDED_MESSAGE` is also used by `browser/tools/credentials.ts` (ticket 05). Whichever of tickets 04 and 05 lands second deletes the constant and the `unattended` plumbing (see the last bullet of ticket 05); the first leaves them in place.

- [x] `browser_request_takeover` in an unattended run no longer refuses. It opens a `takeover` wait that carries the run id, returns `waiting_for_user` at once with the same instruction ("end your turn"), and the run parks as in ticket 02. An attended request behaves as before
- [x] For a request that belongs to a run, `Takeover.request` does not arm the inactivity timer. The timer arms on my first input (`touch`), so a takeover that waits all night does not time out before I come. Until then only the wait's 24-hour expiry applies. Input then keeps the usual 30 minutes between inputs, and a timeout still counts as Skip
- [x] "I'm done" and a hand-back (`/api/browser/control` with `hand_back`) resolve the wait as `done`, and the run resumes in the same session with the existing "take a fresh snapshot" message. "Skip" resumes it with the existing skip message. An expired takeover (24 hours) fails the run as in ticket 02 and releases the browser
- [x] The takeover's browser is held for as long as the wait is open: a second run of the same bot that calls the browser meanwhile gets "user has control" (an existing refusal) and reports it
- [x] A restart cancels the open takeover wait (ticket 01), so the parked run resumes with a message that the browser session is gone, and the bot may ask again
- [x] `docs/browser.md`: the Routines section no longer says a routine cannot request a takeover; it says a routine parks, how long, and that the inactivity limit starts at the first input
- [x] Tests in `browser/routines.test.ts` and `browser/takeover.test.ts` (their "refused in an unattended routine run" cases change): a routine's takeover request parks the run (`waiting`), chat-hosted and headless; with no input for longer than `takeoverInactivityMs` the takeover is still open, and input then starts the timer; a hand-back resumes the run and it finishes `succeeded`; Skip resumes it; the existing attended tests still pass. `bun run check` passes

## Comments

- Deviation (a fix the ticket did not name): `Waits.resolve(id, "timeout")` stored the wait as `expired`, which the run treats as the 24-hour expiry and fails with "approval expired". A takeover's inactivity timeout must count as Skip and resume the run, so `timeout` now closes the wait as `answered` (outcome `timeout`); card label, bot message and attended behaviour are unchanged.
- `Takeover.request` decides "belongs to a run" from the stored wait's `runId`; `begin` takes a flag to skip `arm`. `touch` is unchanged and arms on the first input.
- A second run of the same bot cannot start while one is parked (ticket 02 skips it), so the "user has control" refusal is tested with a second caller of the bot's browser (what a chat or the bot's other tools meet).
- The 24-hour expiry is tested live, not through a restart: a restart cancels an open takeover before the sweep, so the expiry path that matters is the user's late answer (refused 404, wait expires, run fails, browser released), driven with the host's test clock (`now`) in `browser/routines.test.ts`.
- `UNATTENDED_MESSAGE` and the `unattended` plumbing are left for ticket 05 (`browser_login` still uses them).
- Smokes: none needed (`browser/smoke.ts` and the UI are untouched). `bun run check`: 1470 pass, 0 fail; coverage totals lines 96.21% (baseline 96%), functions 93.24% (baseline 93%).
