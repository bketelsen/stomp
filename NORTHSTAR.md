# stomp north star

Read this before changing anything. If a request conflicts with it, stop and ask Brian.

## What stomp is

A web app where I talk to a small team of durable agents: one supervisor and a handful of named
agents, each with a soul (who they are) and responsibilities (what they own). I chat with the
supervisor and it delegates. I can talk to any agent directly. Every code change is reviewed by a
model from a different family before it's reported done. It runs on pi-durable.

## The one test

**When I ask for something, it gets done.**

> "My agents need to get work done." (dish, sandbox-home)
>
> "A security fix that adds a refusal, a hard failure or another approval to normal work is the
> wrong fix." (dish, HANDOFF)

## Principles

1. **Doing beats asking.** Agents act. They stop only for actions that are both outside the
   envelope and not clearly reversible.
2. **Reversible beats permitted.** The envelope (VM, worktree, branch, PR, protected `main`) is the
   safety. A prompt to me is the last resort, not the first.
3. **Automation can say yes or ask me. Nothing automated says no on my behalf.** The judge
   auto-approves or escalates. It never refuses, never sees the task, never asks "does this serve
   the task".
4. **Review always runs; verdicts inform, I decide.** Cross-family, triggered by code, at most two
   automatic fix rounds, blockers only. Then it's my call. Reviewers don't grow scope.
5. **pi-durable owns durability.** We write no recovery, reconciliation, lease or receipt code.
   Interrupted work is reported to the agent, which carries on or asks.
6. **Level-triggered, not edge-triggered.** Background behavior is "if X is true now, do Y",
   idempotent, so a restart needs no special path.
7. **Derive status; don't store it.** One process, one store. No parallel state machines.
8. **Agents use real tools directly.** git, gh and ssh are used by the agent, not proxied through
   host pipelines. Pushing to `main` and merging are the judge's ask rules, not a pipeline.
9. **Souls are short and positive.** Who you are and what you own. No fear lists, no mandatory
   process skills.
10. **Two levels.** Supervisor, then agents. Agents don't delegate. Reviewers and consults are
    ephemeral, not team members.
11. **What I author is a plain file in git.** Agents, souls, house rules, judge rules.
12. **Small enough to read whole.** One agent should be able to hold stomp in context.

## Budgets (tripwires; checked by a script)

| What | Limit |
|---|---|
| App source (server + UI, excluding tests) | 8,000 lines |
| Judge | 300 lines |
| Review | 500 lines |
| Tests | ≤ 1.5× source |
| Docs (excluding this file) | 1,500 lines |
| States a thread shows | idle, working, needs you, reviewing |
| Durable doc kinds we define | 3 |
| Task kinds we define | 2 |
| House rules | 25 lines |
| A soul | 60 lines |
| Automatic review rounds | 2 |
| Asks per delegated task (median) | 0 |

Raising a limit is a decision I make, not a side effect of a change.

## Anti-goals

Plan-approval gates. Evidence, receipt or proof systems. Recovery scripts. Inbox items that aren't
decisions. Multi-user security. Agents messaging peers. Deeper org charts. Superpowers-style process
inside product agents. A judge that refuses.

## Drift alarms

Stop and ask me when:

- a change adds a state, a gate, an inbox kind or a recovery path;
- a fix for friction adds mechanism instead of removing it;
- a reviewer's hypothetical (a race, a crash window, a rare input) is about to become code;
- a week of commits is mostly about stomp itself, not something I can now do;
- an agent refuses or stalls on something I asked for;
- a budget is about to be exceeded.

## Changing stomp

- Every change says what I can do now that I couldn't before.
- Guards need an incident, not a hypothetical.
- Review on stomp's own PRs: cross-family, once, blockers only. A blocker is a bug I'd hit in
  normal use, or data loss. Everything else is a note.
- Delete what you replace, in the same change.
- Friction goes in `FRICTION.md`, one line each. The usual fix is deletion.
