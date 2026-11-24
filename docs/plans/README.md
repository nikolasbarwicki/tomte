# Plans

Working specs and tickets, kept as the design record of how each feature was planned. Each spec states the problem, the user stories, the decisions and the acceptance checks written before the code; its `issues/` folder holds the tickets it was cut into.

They are working documents, not current documentation. A plan describes the feature as it was planned, and some say so at the top when a later decision changed them. What Tomte does today is in [features.md](../features.md), what comes next in [roadmap.md](../roadmap.md), and hard-to-reverse decisions in [adr/](../adr/). Where a plan and those pages disagree, those pages win.

Good places to start:

- [grok-bot-replacement-roadmap.md](grok-bot-replacement-roadmap.md): the plan that drove the project's first stage, with its parity table and decisions. Its later stages are ideas, not commitments; the public [roadmap](../roadmap.md) lists what is planned.
- [unattended-parking/spec.md](unattended-parking/spec.md): how a routine waits for the owner's approval and resumes ([ADR-0009](../adr/0009-unattended-runs-park-on-durable-human-waits.md)).
- [telegram-channel/spec.md](telegram-channel/spec.md): the phone channel ([ADR-0010](../adr/0010-channels-deliver-needs-you-items.md)).
- [background-tasks-chat.md](background-tasks-chat.md): the chat that never blocks ([ADR-0011](../adr/0011-background-tasks-chat-mode.md)).
- [cost-guards/spec.md](cost-guards/spec.md): limits that keep a looping routine from using up the owner's plan.
