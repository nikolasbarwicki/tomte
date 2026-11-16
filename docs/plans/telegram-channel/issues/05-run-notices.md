# 05: Run notices: failed runs and expired parks

**What to build:** The host tells me on my phone when a routine run fails or is interrupted, and when a park expires. These are sent with no setting. They are messages with a link to the Routines panel, not cards: they have no buttons and are not tracked after sending. See the spec section "Notices and results".

Two seams:

- **`Channels.notify(notice)`** sends one plain-text message to the linked account. Notice kinds (a Zod union in the host, not the contract): `run_failed` (bot, routine name, error) and `park_expired` (bot, routine name, title of the wait that expired). `routine_result` is added by ticket 06. A failed send is retried while the adapter's backoff allows and then logged; the run row stays the record, so a lost notice never hides a failure from the web UI.
- **`onRunEnded` in `createRoutines`** (`routines/index.ts`): called once when a run row reaches a terminal status. Today that is in `run()` after `store.finishRun` (`succeeded` or `failed`) and in `reconcile()` through `store.interruptStaleRuns`, which does not return the rows it changed (`routines/store.ts`); make it return them so a host restart that kills a run is reported. With feature 10, a parked run reaches its terminal status after it resumes, and an expired park ends it as `failed` ("approval expired"); the expiry path from `docs/plans/unattended-parking/issues/02-parked-runs.md` must be told apart from other failures without matching the error text, so the callback carries the cause.

An auto-pause or an absence pause is not a notice in this sense. Feature 13 makes it a needs-you item of kind `notice` (`.scratch/13-cost-guards/issues/03-auto-pause-after-failures.md`), which the cards of ticket 03 deliver, so this ticket sends nothing for it.

**Blocked by:** 03, `docs/plans/unattended-parking/issues/02-parked-runs.md`

**Status:** done

- [x] A run that ends `failed` sends `run_failed`: "Routine <name> failed: <error>", the error cut to about 300 characters, and a URL button to `<public URL>/bots/<botId>?panel=routines` (no button on a loopback public URL, as for cards). A run that ends `interrupted` (the host stopped during it, found at the next start) sends the same notice worded as interrupted. A `succeeded` run sends nothing here. A skipped run ("previous run is waiting for you", "missed while offline") sends nothing
- [x] A park that reaches 24 hours sends `park_expired` ("<routine>: <wait title> expired, so the run failed") and not also `run_failed` for the same run
- [x] With no linked account, with no running channel and while the channel is down, `notify` neither throws nor blocks the run: the run's final status and `onChange` happen as before
- [x] `onRunEnded` is called exactly once per run, and for a manual test run (`RunTrigger` `manual`), which is reported like any other. A run stopped by `removeRoutine` is not reported: the cascade owns its row (`entry.removed` in `routines/index.ts`)
- [x] A bot that no longer exists has its failure recorded but sends no notice
- [x] Host seam tests with the fake Telegram server and the fake Claude CLI: a failing routine run sends one notice; a run interrupted by `restart()` sends one after the restart; an expired park (clock moved, as `routines/index.test.ts` does with `now`) sends `park_expired` only; a run that succeeds, and a skipped one, send nothing. `bun run check` passes
