# 07: Check a takeover from my phone

**What to build:** Nothing to build. This is a manual check that a takeover card's link opens the live view in my phone's browser over Tailscale and that touch and typing work there. It answers the open question in Decision 6 and [ADR-0010](../../../docs/adr/0010-channels-deliver-needs-you-items.md): "If touch input does not work there, the takeover waits for the laptop within the 24-hour park, and a mobile live view becomes its own task."

What the code does today, so I know where to look when something fails:

- The live view page sends `touch` events (`onTouchStart`, `onTouchMove`, `onTouchEnd`, `onTouchCancel` in `packages/web/features/browser/browser-panel.tsx`) and the host accepts them (`Touch` in `packages/host/src/browser/input.ts`, sent to the engine as `input_touch`). `touch()` sends `e.touches`, which has no points on `touchEnd`.
- Keyboard input is taken from key events on a focusable element (`tabIndex`, `onKeyDown`), not from a text input, so a phone's soft keyboard may never open. [INFERENCE: not tried on a phone.]
- A takeover that a bot requested gives me control at once (`Takeover.request` in `browser/takeover.ts`); the card has "I'm done" and "Skip". An unattended run refuses takeover today (`UNATTENDED_MESSAGE`, `browser/tools/takeover.ts:21`); feature 10 lifts that for a routine run by parking it.

**Blocked by:** 04, `.scratch/10-unattended-parking/issues/02-parked-runs.md` (and feature 10's ticket that parks a takeover, which had no number when this was written)

**Status:** ready-for-human

Before starting:

- [ ] The host runs on the VPS in remote mode behind `tailscale serve`, with `--public-url` set to its `https://<machine>.<tailnet>.ts.net` address (deploy kit option B in `deploy/README.md`). Check that `<public URL>` opens the web UI on the laptop
- [ ] The phone has Tailscale installed and connected to the tailnet, and its **system browser** (Safari or Chrome) is paired with the host: open `<public URL>`, enter a pairing code from the Devices page. Note whether the Telegram in-app browser, opened from a card's link, is signed in too, or asks for a pairing code
- [ ] Telegram is linked (ticket 02), and a bot has the browser switched on. A routine on that bot (name it "Takeover check", notify result on) whose instruction is: open a page that needs a human (the reCAPTCHA demo at `https://www.google.com/recaptcha/api2/demo` is one), call `browser_request_takeover`, and after the answer report what the page says

The check:

- [ ] Run the routine from the Routines panel. A card arrives in Telegram with the reason, a link button and "I'm done" and "Skip". The run shows `waiting`
- [ ] Open the link from the card. Record whether it opens in the Telegram in-app browser or the system browser, and whether the live view loads in each. If the in-app browser has no session, open the link in the system browser and note that as the fix to write in `deploy/README.md`
- [ ] In the live view on the phone: the page is visible and updates; a tap on a button or link on the page lands where the finger is; a drag scrolls the page; tapping a text field opens the phone's keyboard and typed characters appear in the field; the browser stays under my control until I finish
- [ ] Finish the takeover (solve the CAPTCHA), then press "I'm done" on the card in Telegram. The run resumes in the same session, ends `succeeded`, and the result message arrives
- [ ] Record the result under `## Comments` below: phone model and browser, what worked, what did not, and a screenshot or two if something failed

If touch or typing does not work:

- [ ] Write a new ticket, `.scratch/11-telegram-channel/issues/NN-mobile-live-view.md` (`Status: needs-triage`), naming exactly what failed (no soft keyboard, wrong tap position, no scroll, a layout that does not fit) and pointing at `browser-panel.tsx`. It is not part of the cancel gate
- [ ] Check the fallback instead: leave the card unanswered, open the laptop's desktop app (remote profile), take over from there within the park, press "I'm done", and see the run finish. Record it. A takeover that waits for the laptop is within the plan
