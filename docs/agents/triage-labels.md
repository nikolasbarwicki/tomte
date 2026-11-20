# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the label strings used in this repo. Planning tickets in `.scratch/` record the role as a `Status:` line; public GitHub issues carry it as a label of the same name.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Public GitHub labels

Every issue form adds `needs-triage`. Triage replaces it with a role above and adds the labels below.

| Label              | Meaning                                                                                      | Role it usually goes with            |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| `bug`              | Something does not work as documented                                                        | any                                  |
| `enhancement`      | New or changed behaviour                                                                     | any                                  |
| `documentation`    | Docs only                                                                                    | any                                  |
| `security`         | A security fix or hardening (reports themselves go to private vulnerability reporting)       | any                                  |
| `good first issue` | Small, fully specified: context, files to touch, how to verify                               | `ready-for-human`, `ready-for-agent` |
| `help wanted`      | The maintainer cannot do it alone (another OS, a language, a package manager)                | `ready-for-human`                    |
| `area:host`        | `packages/host`, `packages/notify`, `packages/contract`                                      |                                      |
| `area:web`         | `packages/web`                                                                               |                                      |
| `area:desktop`     | `packages/desktop`, packaging, signing, auto-update                                          |                                      |
| `area:channels`    | Telegram and other channels (`packages/host/src/channels`, `packages/web/features/channels`) |                                      |
| `area:deploy`      | `deploy/`, remote mode, the release workflow                                                 |                                      |

`duplicate`, `invalid` and `question` close an issue (a question moves to Discussions). `wontfix` is the role above.
