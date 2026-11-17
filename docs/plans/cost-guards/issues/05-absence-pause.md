# 05: Routines pause when I am away for `pauseAfterAbsenceDays`

**What to build:** A host setting, `pauseAfterAbsenceDays`, pauses every routine when the owner has done nothing in the web UI for that many days, warns 2 days before, and resumes the routines the pause stopped on the owner's next action. This ticket counts web activity; ticket 06 adds channel activity. See the spec section "Absence pause".

The host has no stored settings store. Every host setting is a startup flag parsed once into `HostConfig` (`platform/config.ts`), so this follows that pattern: `--pause-after-absence-days` and `TOMTE_PAUSE_AFTER_ABSENCE_DAYS`, default 0 (off). My VPS sets 14 in its unit's environment.

Presence cannot come from `devices.last_seen_at`: `authenticate` in `device-auth/index.ts` updates it on every authenticated request, including each reconnect of the event stream that the desktop app follows all day for its banner. Presence is any accepted device request except `GET /api/events`.

**Blocked by:** [03](03-auto-pause-after-failures.md)

**Status:** done

- [x] `HostConfig.pauseAfterAbsenceDays` (non-negative integer; 0 off; default 0) is parsed from the flag and the variable, flags winning, with `InvalidConfig` for a negative or non-integer value. `platform/config.test.ts` covers it. `deploy/README.md` documents it and the systemd unit's environment shows it, in step with `platform/config.ts`
- [x] A new `presence` feature module (ADR-0003: an `index.ts` interface, no imports from `routines/`) keeps one database row, added by a new append-only schema step: the time of the last action and the time of the last warning. `touch(now)` is throttled to one write a minute. With no row, the first read writes now, so turning the setting on never pauses at once, and a restart does not reset the clock
- [x] `host-server/boundary.ts` touches presence when `devices.authenticate` accepts a request, except `GET /api/events`. An open event stream alone never counts as presence
- [x] A check runs once at start and every hour (a timer in the composition root, `unref`ed, stopped with the host). With the setting above 2 days and the owner away for `pauseAfterAbsenceDays - 2` days, it raises one warning notice per bot that has an active routine ("Routines will pause in 2 days unless you open tomte"), once per absence. With the setting at 1 or 2 there is no warning
- [x] Past `pauseAfterAbsenceDays`, the check pauses every active routine with `paused_reason = 'absence'` (schedule disarmed, `onChange` called) and raises one notice per affected bot that names the routines. A routine already paused for `failures`, or switched off by the owner, is left alone. With the setting at 0 the check does nothing
- [x] The first presence touch after an absence pause resumes every routine whose reason is `absence`, with the existing baseline rule (no catch-up flood), closes the warning and pause notices as `resolved`, and clears the warning mark. Routines paused for `failures` or by the owner stay paused
- [x] The Routines panel shows "Paused: no activity for N days" for reason `absence`
- [x] `routines` exposes what the composition root needs (pause all with a reason, resume by reason); the composition root wires presence to it, so `presence/` stays free of routine code
- [x] GLOSSARY gains **Presence** (the owner's last action: any request from a paired device except the event stream, or a message or button from the linked channel account)
- [x] Tests with a fake clock at the host HTTP seam (`--pause-after-absence-days 14`, a paired device, the fake CLI): 12 days away raises the warning once, not twice; 14 days pauses every active routine and raises the notice; an event stream open for those days does not count as presence; one POST from the paired device resumes the absence-paused routines and closes the notices, and leaves a failures-paused routine paused; a restart in between does not reset the clock; the setting at 0 never pauses. `bun run check` passes
