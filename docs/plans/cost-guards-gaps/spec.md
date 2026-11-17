# Spec: close the three gaps left by cost guards

Follow-up to `.scratch/13-cost-guards` (merged into master as c23db66). The cost-guards coordinator listed these as untested or unhandled when it finished. Each is one ticket below.

1. Front chat turns of a double-loop bot are not metered, so run usage and any future spend view undercount those bots.
2. `session_usage_marks` rows are never removed when a bot (and its sessions) is deleted.
3. Re-arming a paused routine's Bun.cron schedule after a resume is only proven through a host restart; the gate test used manual runs.

Out of scope: changing what counts toward auto-pause, the 30-min cap, or the absence pause.
