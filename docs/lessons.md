# Lessons from onionsoup and dish

The evidence behind the north star, gathered on 2026-10-06 from both repositories, their git
history and the runtime state in `~/.config/onionsoup` and `~/.local/share/onionsoup`.

## The pattern

| | onionsoup | dish |
|---|---|---|
| Lifetime | 2026-09-18 to 10-02, 288 commits | 2026-09-30 to 10-06, 596 commits |
| Source / tests | 34k / 28k lines, plus 7.2k lines of scripts | 77k / 119k lines |
| Docs | owners.md grew from 133 to 1,485 lines; gaps.md from 39 to 285 | 1.8 MB of specs and plans; one plan is 406 KB |
| Late-stage work | 09-26 to 10-02: ~50k lines inserted, ~2% user-visible | Each friction session became a new spec, decisions table and mechanism |

Both projects were built by agents at very high velocity, using spec → plan → per-task implementer →
per-task review → fix rounds. Each strict review found edge cases, each fix added state, and more
state meant more edge cases. Both projects also put the same process inside the product's own agents.

## What to keep

**Cross-family review.** onionsoup recorded 122 verdicts (32 revise) and 274 findings, 14 of them
blockers. Real catches included a Coder unit that could open a public tunnel, a credential proxy
that injected credentials into any HTTP method, a Debian `postgresql.service` no-op, and an Ansible
copy to a directory that didn't exist. The shape that worked was commit 122dda7: review once, at one
choke point, only blockers sent back. The reviewer gets the diff, the claim and test exit codes, not
the conversation. dish's version kept the parts that matter: family chosen from the model id, a
structured verdict pinned to the head sha.

**Personas.** onionsoup's persona YAML (name, title, voice) plus a charter (domain, goals,
boundaries) was clean and portable. The cast in `~/.config/onionsoup/owners`: Leto, Miles Teg,
Moneo, Bellonda, Odrade (who managed seven), Murbella, Lucilla, Sheeana, Taraza, Rebecca, Hwi Noree,
Scytale, clippy and Duncan.

**Notebooks.** The homelab notebook holds 944 lines of genuinely useful facts. Distilled rejections
stopped agents from re-proposing rejected ideas.

**The wiki.** This was onionsoup's anti-ceremony success: the keeper wrote directly, and each write
was a git commit with a secret scan. Only deletes asked.

**Read-only consults.** `onionsoup_ask` returned answers split into observed, inferred and unknown,
and produced about 200 useful exchanges.

**Deterministic duties.** Host code checked on a schedule and woke a model only when needed
(maintain-prs, app-updates).

## What to drop, and why it grew

1. **Strict rules applied to everything.** "Effects happen in host code, behind gates" and "claims
   are not evidence" fit VM creation. They were also applied to an owner editing its own repo.
2. **Host-only landing.** Owners couldn't commit or push, so the host owned publication: desks,
   plan worktrees, sync, squash detection and PR maintenance. Most owner-filed friction records are
   this machinery blocking the actual task.
3. **Three processes sharing files** (daemon, plugin, CLI). Each crash window needed locks, then
   leases, then receipts, then reservations.
4. **Fail-closed with no replay.** Every interrupted step, even posting a chat notice, became a
   permanent "uncertain" record that needed a human, a proof script or a quarantine.
5. **Layered delegation, each layer with its own durable delivery.** ask, requests, initiatives,
   grants, steer, escalations, send/reply.
6. **Prompt-level ceremony.** The vendored superpowers bootstrap said a skill must be invoked if
   "there is even a 1% chance" it applies, before any response. The owner prompt was 6 lines of
   voice followed by 40 lines of process. dish's prompts mandated brainstorm → spec → plan →
   subagent development → review after every task.
7. **Lifecycle sprawl.** onionsoup had 15 work states, 16 or more request states, and 11 inbox kinds.
   An estimated 55–65% of the engine was gating, recovery or evidence code.

## The judge (dish)

TypeSafe's Jev is fast and cheap: about 165 ms p50, $0.042 per million input tokens. It returns
probabilities and confidence, never explanations. dish wrapped it in 10.4k lines of source and
15.6k lines of tests.

**Why it added friction instead of removing it:**

- **It sat in front of every shell call.** Under dsh's sandbox, in-workspace commands already ran
  without asking. Measured against that baseline, the judge could only turn "runs" into "asks".
- **`serves_task` caused most asks.** A relevance check run over a reconstructed transcript
  produced most of the asks in every incident. Each fix added more task-assembly machinery while the
  bar stayed where it was.
- **Children failed closed into denials no human saw.** One coder retried the same command four
  ways.
- **Fail-closed defaults.** With no key or after a 2 s timeout, it asked about every command.
- **Sandbox mismatch.** A read-only home and a per-call /tmp made normal commands look like
  escalations.

**The friction incidents:**

- **Astro.** Half of 47 minutes went to approvals.
- **First project session.** It asked 10 times in 7 minutes; 9 of those were read-only commands.
- **clippy README.** 24 of 66 commands were stopped, 15 of them for writing to /tmp.
- **nsl.** "Read-only review" was taken as the task two days later, and the `never` policy turned
  asks into false rejections.

## The meta-lesson

The product and the process that built it drifted together. stomp's own development follows the
north star's "Changing stomp" rules, and a budget script makes drift visible before it compounds.
