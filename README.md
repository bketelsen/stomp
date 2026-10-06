# stomp

**A small team of AI agents you can talk to from a browser.** stomp gives you a supervisor and a few
specialists. Each has a personality and a job. They work in a VM you own and remember what they learn.
A model from another family checks their code, and they stop to ask you only when it matters.

You talk to the supervisor the way you'd talk to a lead. It hands work to the right specialist,
keeps talking with you while they work, and tells you what came back. You can also step into any
agent's thread and talk to it directly.

## Why

Most agent tools are one agent in one terminal. That works until you want help with several things
at once: a repo, a homelab, a docs site, a release pipeline. Then the usual tools have four
problems.

- **Permission fatigue, or none at all.** Agents either ask before every command, so you babysit
  them, or never ask, so you hope for the best. stomp runs agents freely inside a disposable VM. A
  fast judge clears what's local or reversible. You get a one-tap question only for commands that
  reach outside and can't be undone, like a push to `main`, a merge or a delete.
- **Same-model blind spots.** A Claude agent reviewing Claude's work shares its mistakes. In stomp,
  every commit an agent makes is reviewed by a model from a *different family*, triggered by code,
  not by asking nicely. Blocking findings go back to the author for up to two rounds, and the rest
  are reported to you as notes.
- **Work that dies with the process.** stomp is built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable).
  Conversations, delegations and reviews are durable tasks over SQLite, so you can restart the server
  mid-command and the agents carry on, told what was interrupted.
- **Process that eats the work.** Agent systems tend to grow approval gates, state machines and
  recovery scripts until they stop doing what you asked. stomp's own rules (see
  [NORTHSTAR.md](NORTHSTAR.md)) are built against that. There are line budgets enforced in CI, and
  automation is never allowed to say no on your behalf.

## What it's like

You ask the supervisor: *"Rook, our homelab agent, should find out why fleet's CI is red and fix it.
Meanwhile, what did we decide about the backup schedule?"*

1. The supervisor delegates to Rook in a new thread and answers your question from its notebook.
2. Rook works in his own git worktree on a branch, finds the problem, commits a fix and opens a PR.
3. Rook runs on Claude, so a GPT reviewer reads the diff. It finds a real bug, and the finding goes
   back to Rook, who fixes it and commits again. Round two approves, with two notes.
4. Rook's report reaches the supervisor with the verdict and the notes. The supervisor tells you in
   two sentences, and you merge.
5. Later, Rook wants to restart a service on a production host. The judge reads it as risky, and
   you get *"Rook needs you"*, with the command, an Allow button and a Deny button.

Overnight, a scheduled check notices a host stopped answering. It wakes Rook, who investigates and
reports through the supervisor. It's waiting for you in the morning.

## Features

- **Agents are markdown files.** A soul (who they are), responsibilities (what they own), a model,
  and optionally scheduled duties. Edit the file and the agent changes on its next turn.
- **A supervisor with delegation.** It hands jobs to agents and keeps talking while they work. It
  gets each report exactly once, even across restarts, and can steer or cancel any thread. The org
  chart is two levels deep, on purpose.
- **Direct chat.** Any agent, any thread, with streaming, steer (redirect a run mid-flight) and abort.
- **Cross-family review.** Every agent commit in a worktree is reviewed by the first model in your
  pool whose family differs from the author's. The verdict is computed from the findings, not taken
  from the model, so nits can't turn into fix rounds.
- **The judge.**
  - Your rules and built-in rules come first.
  - Then [Jev](https://typesafe.ai), a fast structured classifier taking about 170 ms per command.
  - Then your local model.
  - Then it asks you.
  - It never denies on its own. "Always allow" learns the exact command.
- **Asks you answer in one tap.** Inline cards, a "needs you" list, the tab title, and desktop
  browser notifications. Phone notifications wait on the installable app, which is a later item.
- **Notebooks and consults.** Agents `remember` things across threads, and you can read and edit
  their notebooks. They can `consult` each other for read-only answers.
- **Duties.** A check on a schedule wakes an agent only when the result changes, and the finding
  comes back through the supervisor.
- **Your subscriptions, not API bills.** GitHub Copilot, ChatGPT (Codex) and Claude Pro/Max sign in
  with OAuth through [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai), plus any
  OpenAI-compatible server (llama.cpp, vLLM, Lemonade, …). Agents name models by alias, so switching
  providers is a one-line change.

## How it works

One Node process: a pi-durable harness over one SQLite file, an HTTP and WebSocket bridge, and a
React UI. Agents run shell commands inside an Incus VM. The VM, and the credentials you put in it,
are the security boundary.

```
browser ── HTTP + WebSocket ── stomp (Node 24) ── pi-durable harness ── SQLite
                                   │                  │
                       ~/.config/stomp (git)          └── pi-ai: Copilot, ChatGPT, Claude, local
                       agents, house rules, judge rules
```

An agent file:

```markdown
---
model: claude-sonnet          # an alias from stomp.yaml
duties:
  - name: hosts
    every: 15m
    check: for h in host-a host-b; do timeout 3 bash -c "</dev/tcp/$h/22" && echo "$h up" || echo "$h down"; done
    brief: A host's reachability changed. Find out why and say what you found.
---
# Rook

You are Rook: calm, economical with words, and precise about the state of the homelab. You prefer
the reversible move.

## Responsibilities
- The homelab's configuration repo: Ansible, OpenTofu, Caddy.
- Answers about compute and virtualization for the rest of the team.
```

The supervisor's file adds `role: supervisor`. House rules shared by every agent live in
`house.md`, and stay under 25 lines.

## Getting started

**You need:**
- Node 24 or later.
- At least one model source: a GitHub Copilot, ChatGPT or Claude subscription, or an
  OpenAI-compatible server.
- For the recommended setup, [Incus](https://linuxcontainers.org/incus/) on the machine that hosts
  the VM.
- Optionally, a [TypeSafe](https://typesafe.ai) API key for the judge. Without one, a local model
  judges; without either, stomp asks you about anything its rules don't clear.

**In a VM (recommended).** Agents run real shell commands, so give them a machine of their own:

```bash
git clone https://github.com/bketelsen/stomp && cd stomp
cp -r examples/home ~/.config/stomp       # edit stomp.yaml and agents/ to taste
deploy/vm.sh create                       # Debian 13 VM with Node, mise and Homebrew
deploy/vm.sh config                       # copy ~/.config/stomp in (no secrets live there)
deploy/vm.sh update --apply               # push this checkout, build, start the service
deploy/vm.sh login github-copilot         # or openai, anthropic; run in the VM, finished in your browser
deploy/vm.sh secret TYPESAFE_API_KEY      # optional: the judge's key, read silently
```

Then open http://127.0.0.1:7311. To let agents push branches and open PRs, run
`deploy/vm.sh login github`. [deploy/README.md](deploy/README.md) has the details.

**On your own machine,** to try it, knowing agents get your shell:

```bash
npm install && npm run build
cp -r examples/home ~/.config/stomp
npm run login github-copilot
npm start                                 # http://127.0.0.1:7310
```

**Configuration,** in `~/.config/stomp/stomp.yaml`:
- model aliases;
- local providers;
- the review pool, for example `review: { pool: [gpt, claude-sonnet, gemini], rounds: 2 }`;
- judge thresholds.

Your own judge rules go in `~/.config/stomp/rules.yaml`. See [examples/home](examples/home).

## Honest limits

- **The judge is a safety net, not a sandbox.** An agent that writes a script and runs `npm test`
  runs whatever it wrote. Only the VM contains that. Give the VM only the credentials you'd hand a
  careful new teammate.
- **Your GitHub login in the VM can't tell agents from you.** A push to `main` and `gh pr merge` ask
  you through the judge, not through GitHub. Branch rulesets don't stop an admin's token.
- **Claude Pro/Max through pi-ai is a gray area.** pi-ai's Claude login presents itself as Claude
  Code, and Anthropic's terms for third-party use have changed several times. Use it knowingly, or
  route Claude models through Copilot.
- **pi-durable is new and experimental.** stomp pins an exact version.
- **This is a personal project, built in the open.** Expect sharp edges and breaking changes.

## Design

- [NORTHSTAR.md](NORTHSTAR.md): the one-page rules. Read it before changing anything.
- [docs/plan.md](docs/plan.md): the architecture, phase by phase.
- [docs/lessons.md](docs/lessons.md): what two earlier attempts taught, with evidence.
- [docs/spike.md](docs/spike.md): the experiments that validated pi-durable first.

`npm test`, `npm run typecheck` and `npm run budget` run in CI. `npm run judge:eval` runs 183
labeled commands through the real judge, and needs a TypeSafe key.

## License

[MIT](LICENSE)
