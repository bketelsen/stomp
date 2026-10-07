# stomp plan (draft 1, 2026-10-06)

Read [NORTHSTAR.md](../NORTHSTAR.md) first. The evidence behind it is in [lessons.md](lessons.md).
Nothing here is built yet. Decisions are at the end.

## Shape

```
 browser (desktop or phone, over tailscale serve)
    │  HTTP for commands, one WebSocket for live views
 ┌──▼───────────────────────────────────────────────────────────┐
 │ stomp: one Node 24 process                                    │
 │  http/ws bridge ── pi-durable Harness ── SQLite (one file)    │
 │                     │ registry: stomp extensions and tasks    │
 │                     │ models: pi-ai (Copilot, ChatGPT, Claude, local Qwen)
 │  agent loader ◄── ~/.config/stomp (git): agents, house, rules  │
 │  worktrees    ──► ~/.local/share/stomp/work                   │
 └───────────────────────────────────────────────────────────────┘
        runs inside the envelope: an Incus VM with scoped credentials
```

One process, one store, one Harness for every agent. pi-durable needs a single Harness for
cross-conversation submits and doc access anyway, and it has no cross-process locking.

## Vocabulary

This is the whole vocabulary. A new noun needs a north star change.

| Term | What it is |
|---|---|
| **Agent** | A file: soul, responsibilities, model, repos. |
| **Supervisor** | The one agent with delegation tools. |
| **Thread** | A pi-durable conversation with one agent. Each agent has a desk thread. Delegations and "new thread" create more. |
| **Delegation** | A thread the supervisor started. When it settles, it reports back. |
| **Review** | A cross-family check of a thread's new commits. |
| **Ask** | A pending yes/no for me. |
| **Envelope** | Where agents run, and the credentials they hold there. |

## Models and providers

Subscriptions only. Jev is the one API key.

| Source | pi-ai provider id | Families | Standing | Role in stomp |
|---|---|---|---|---|
| ChatGPT / Codex | `openai` ("Sign in with ChatGPT"; `openai-codex` is legacy) | GPT | OpenAI publicly endorses third-party harnesses | Workhorse for GPT-family agents and reviews |
| GitHub Copilot | `github-copilot` (device flow) | Claude, GPT, Gemini and more | Official third-party support | Gemini as a third family; Claude fallback (one alias away); GPT alternative |
| Claude Pro/Max | `anthropic` | Claude | pi-ai's OAuth path impersonates Claude Code ("stealth mode", `claude-cli` user agent, a forced "You are Claude Code" system block); Anthropic's policy changed three times this year | **Used, by Brian's choice.** It's the primary Claude route, with Copilot's Claude one alias away. |
| Local Qwen3.8 (`halogen-qwen3.8-flash-next`, 262k context) | custom `local`, via `createProvider` (openai-completions) | Qwen | Yours | Cheap and private: titles, compaction summaries, notebook upkeep, low-stakes agents, a possible judge backend |

**Family.** pi-ai has no vendor field, so family comes from the model id, the way dish's
`vendorsOf` did it. A built-in table maps `claude|fable` → anthropic, `^(gpt|o\d|codex)` → openai,
`gemini|gemma` → google, `qwen` → qwen, `grok` → xai, `kimi|k\d` → moonshot. `stomp.yaml` can extend
it. Claude through Copilot is still `anthropic`.

**Account models.** The models an account offers can differ from pi-ai's built-in catalog. An alias
can point at a model the catalog doesn't know, as long as `stomp.yaml` gives its `api` and context
window.

**Aliases.** Agent files name models by alias (`model: claude-sonnet`). `stomp.yaml` maps each alias
to a provider and model, e.g. `claude-sonnet: anthropic/claude-sonnet-5-5`. Moving every Claude agent
to Copilot is then a one-line change (`github-copilot/claude-sonnet-5.5`) if Anthropic's policy or
billing changes, and swapping between Codex and Copilot for GPT works the same way.

**Claude subscription caveats.**
- pi warns that "Third-party harness usage draws from extra usage and is billed per token, not your
  Claude plan limits." In the spike, every response said the request counted against the plan's
  5-hour limit and that extra usage, which is off, was rejected. The usage view shows plan usage from
  the `anthropic-ratelimit-unified-*` headers, so a change in Anthropic's policy shows up early.
- The forced Claude Code system block comes first. Souls still set the voice once seeded as below.

**Rules.**
- A thread never changes family mid-conversation. Converting thinking blocks across vendors is
  untested; reviewers get their own conversations anyway.
- Usage per thread (`pi.usage`) and per provider is visible in the UI from phase 2.

## Agents

One file per agent in `~/.config/stomp/agents/`. The filename is the id. Ids below are
illustrative.

```markdown
---
model: claude-sonnet
thinking: medium
repos: [bketelsen/fleet]
---
# Miles Teg

Bashar. You plan the retreat before the advance: calm, patient, quietly certain. You say what
you'll do in a sentence and then do it.

## Responsibilities
- bketelsen/fleet: OpenTofu, Ansible and Caddy for the homelab
- The homelab's Incus hosts
```

- The supervisor's file adds `role: supervisor`. There is exactly one.
- What an agent sees, as pi-durable system prompt sections:
  - `house.md`: shared rules, 25 lines at most;
  - its own soul and responsibilities;
  - its notebook;
  - for the supervisor only, a **Team** section, generated from the agent files and live thread
    state.
- The soul is **seeded in `createConversation`'s `init`** as a `pi.system` entry. Otherwise pi-durable
  sends it after the first user message as an "updated section" (#10542), never in the top-level
  system prompt. The spike confirmed this on both Claude routes and verified the fix.
- Copilot Claude rejects thinking "off", so the agent loader defaults `thinking` to medium.
- Every thread gets an **explicit** extension array built from its agent file. pi-durable's default
  selects every installed extension, which would hand authors the reviewer's `verdict` tool and
  subordinates the supervisor's tools.
- Sections are re-sent only when they change, so the prompt cache stays warm.
- Editing a file takes effect on the next request. The loader watches the directory and
  reconfigures each agent's threads.

**House rules, draft** (the tone matters more than the words):

```
You're on Brian's team. Do what's asked. Ask only when you truly can't proceed.
- Work on a branch in your worktree, commit as you go, open a PR when it's ready. Brian merges.
- Say what you did and how you checked it. If you didn't check, say so.
- For big or unclear work, state your plan in two lines and start. Brian will redirect you.
- Irreversible actions outside this machine are checked by the harness. You don't need to ask first.
- Save what's worth knowing next time with `remember`.
```

## Threads, delegation and direct chat

**Threads.** Every thread is an **ownerless** pi-durable conversation, configured from its agent's
file: model, instructions, extension selection, and `cwd`. Ownerless threads outlive whatever
created them and stay open for me to type into. `stomp.threads`, a session-scoped doc, maps each
thread to `{agent, title, repo?, worktree?, branch?, base?, delegatedBy?, review}`. Names map to ids
in `stomp.agents` (pi-durable has no names).

**Direct chat.** Opening an agent shows its desk thread. "New thread" starts a fresh one. I can open
any thread, including a delegation in progress, and type into it: `followUp` by default, `steer` as
an option.

**Delegation is asynchronous.** It follows pi-durable's background-subagent pattern
(`test/examples/23-subagent-background.ts`). The supervisor's tools:

| Tool | Does |
|---|---|
| `delegate(agent, brief, repo?)` | In one commit: creates a thread for `agent` (and its worktree if `repo` is given), records it, and starts a background `Delegation` task owned by the supervisor's conversation. Returns at once, so I keep talking to the supervisor. |
| `message(thread, text)` | Follow up or steer any thread. |
| `cancel(thread)` | Aborts the thread and its Delegation. |
| `read(thread, last?)` | The last messages of any thread. |

**`Delegation` task phases** (the spike measured 153 lines for this, with all the tools):
1. `deliver`: submit the brief (`requestId: deliver:<task>`), then wait until the thread is idle.
   The report carries **every answer since the brief's**, in order, so a steer or follow-up I type
   into the thread mid-work adds to the report. Reporting only the latest answer lost the brief's
   answer in the first real run.
2. `review`: look up or create the Review for the thread at its HEAD, in one commit, and wait for it.
   Skip this if there are no new commits.
3. `report`: submit to the supervisor (`followUp`, `requestId: report:<thread>:<answerId>`) the
   agent's answer, the review verdict and the branch or PR. Keying on the answer means two
   delegations answered by the same run report once. Then wait for the supervisor's answer, and
   re-queue if the report was withdrawn: Esc on the supervisor withdraws queued input, reports
   included.

The report submission is the wake-up. It starts a supervisor turn, or queues behind the current one.
Checkpoints and request ids make every phase restart-safe; the spike killed it at five points with
no code of our own.

**`cancel`** goes through the host's Harness, because tools can't abort tasks: `abortTask` the
Delegation, then `thread.abort()`. The thread stays open for input.

**Questions from agents.** If an agent ends its turn with a question, the question is in the report.
The supervisor answers with `message` if I already told it the answer; otherwise it asks me.
Questions get no special state.

**Hazard.** pi-durable doesn't detect wait cycles (#10411). The rule: no supervisor tool waits on a
Delegation or thread without aborting it first, and agents get no tools that wait on other
conversations. The background tasks' own waits are safe.

**No timeouts.** Nothing in pi-durable times out a run; in the spike, a Qwen agent reasoned for over
five minutes on an elaborate brief. The UI shows elapsed time on working threads, and abort is one
click. A wall-clock limit per agent comes only if this bites in real use.

## Cross-family review

**Binding.** A thread gets at most one worktree:
- `delegate(…, repo)` binds it up front;
- or the agent calls `workspace(repo)`, which creates
  `~/.local/share/stomp/work/<agent>-<thread>` on branch `stomp/<agent>/<thread>` and sets the
  thread's `cwd`.

Non-repo work happens in a scratch directory and isn't reviewed. The judge covers it.

**Trigger: level-triggered host code.** On every commit event and at startup, for each bound thread:
if it's idle, `HEAD ≠ review.sha`, `HEAD ≠ review.requested`, and no Review is running for it,
record `requested = HEAD` and start `Review(thread, HEAD)` in the same commit. That allows one
attempt per HEAD, so a Review that faults can't re-trigger forever. The check is idempotent, so a
crash at any point just means the check runs again. Uncommitted work is
never reviewed; agents commit when a unit is done. This trigger can't live in a hook: pi-durable
hooks can't create tasks, and `onYield` isn't airtight.

**`Review` task phases:**
1. `review`: an ephemeral, task-owned conversation. It starts as a copy of the author's agent, so
   model, extensions, tools, instructions and `cwd` are all set explicitly.
   - **Model:** the first in `review.pool` whose family differs from the author's. The loader
     rejects agents of unknown family, and a pool without a second family is a startup error.
   - **Tools:** read, bash in the worktree (judged like any other), and `verdict`.
   - **Input:** the brief (from the Delegation if there is one, else the latest request before
     the commits), the author's last message, the worktree path, `git diff base...HEAD` capped at
     60k characters, and the repo's test command if one is declared.
   - **Not given:** the author's conversation.
2. `verdict` is a tool with a typed schema: `approved | changes_requested`, plus
   `findings[{severity: blocking | note, file?, line?, summary}]`. Only `blocking` counts. If the
   reviewer never calls it, it gets one follow-up nudge, and then the result is recorded as
   "review failed", which blocks nothing. Calling `verdict` ends the reviewer's run
   (`control: terminate`).
3. `fix`: if any findings are blocking and fewer than 2 rounds have run, the blocking findings are
   submitted into the thread and the task waits. If the agent committed, it goes back to `review` on
   the new HEAD.
4. `done`:
   - writes `review = {sha, verdict, findings, reviewer, rounds}` into `stomp.threads`;
   - appends an `app.review` entry to the thread, a write submission that doesn't trigger a turn,
     which the UI renders as a card. Tasks can't make write submissions, so this goes through the
     host's Harness, wired in before `resume()`. The UI identifies cards by `kind`.

The verdict, its notes, and the author's replies to the reviewer travel with the report. The review
card sits in the thread. Getting the verdict into a PR the agent already opened is a later item: it
needs either an extra author turn per review or stomp commenting on PRs itself. Review never blocks me
from merging, pushing or moving on. After two rounds, open findings are mine to decide. Abort and
`cancel` stop a thread's review along with its run.

## The envelope, the judge, and asks

**Envelope.** stomp runs in an Incus VM, like dish. Inside it, agents are free. The VM holds:
- Brian's own `gh` login (`deploy/vm.sh login github`). GitHub can't tell agents from Brian, and his
  admin rights bypass frostyard's rulesets, so "Brian merges" is a house rule until phase 4. Then
  the judge's static ask rules cover pushes to a default branch and `gh pr merge`;
- the provider credentials;
- later, scoped ssh keys for the agents that do ops. **Credentials arrive with the judge (phase 4),
  not before.**

**The gate.** A `beforeTool` hook on `bash`, shipped **inside the extension that provides `bash`**.
The spike showed that a child conversation's extension edits can otherwise drop a separate guard and
leave its bash unguarded. Rules match at command position and ignore quoted text; in the spike, a
naive `tofu destroy` rule caught an `echo` into a runbook.

1. **Static `allow` rules** from `rules.yaml`, which run at once:
   - common read-only and local dev commands, installs included;
   - `git push [-u|--force-with-lease] [origin] [HEAD|stomp/*]` (never `-f`, never main or master);
   - `gh pr create|comment|edit|ready|close` and `gh issue create|comment|edit`;
   - every rule I add with "always allow".
2. **Static `ask` rules**, which always ask me:
   - push to a default branch, `gh pr merge`, `tofu destroy`, `incus delete|rm`, `rm -r` on `~`,
     `$HOME` or `/`;
   - anything piped into `sh` or `bash`;
   - anything naming stomp's credential file.

   Jev reads `incus delete` as local on every wording, so the static rule is required.
3. **Everything else goes to Jev:** one `choice` question about the command's furthest-reaching
   effect, asked in both option orders as two questions in one call, with the probabilities
   averaged.
   - **State:** the command, `cwd`, and one line describing the envelope ("a disposable VM";
     naming Incus made Incus commands look local). No transcript, no task.
   - **Options:** `local_only`, `remote_read_only`, `remote_reversible`, `remote_irreversible`. Each
     comes with examples; reversible is explicitly not for anything that touches main, deletes,
     force-pushes, merges, publishes or deploys. The wording is `BOUND` in
     `src/server/judge.ts`.
   - **Routing:**

   | Jev says | Result |
   |---|---|
   | P(local_only) + P(remote_read_only) ≥ 0.7 | Run |
   | Otherwise, P(remote_reversible) ≥ 0.85 | Run |
   | Anything else | Ask me |

4. **If Jev errors:** ask local Qwen the same question in single-token logprob mode (thinking off,
   about 0.7 s), with the same routing. If that fails too, ask me. It never denies.

**MCP tools** go through the same guard, shipped in each `mcp-<server>` extension. A call is judged
as the command `mcp <server> <tool> [--read-only|--destructive] '<args as JSON>'`, marked from the
tool's annotations: `readOnlyHint` runs by a built-in allow rule, `destructiveHint` asks ("rule:
destructive MCP tool"), and an unmarked tool goes to Jev, which sees the tool name and arguments. My
rules come first, so `agents: { moneo: { allow: ["mcp truenas app_update **"] } }` lets one agent
update apps without asking. Annotations are the server's word, like a make target's name: a server
that marks a write read-only is believed.

**Measured** on 176 labeled commands: 0 asks for a typical 40-command coding task, 2 for an ops task,
and no false runs. A keyword fallback would have run `npm publish` and `make deploy`, so there isn't
one.

**What the judge is not.** It's a safety net for honest, fallible agents, not a sandbox against a
hostile one. An agent that writes a script and runs `npm test` runs whatever it wrote, and so do
`git` hooks, `tar --to-command` and similar. The VM and the credentials it holds are the boundary.
Known gaps:
- a push config set in an earlier, separate command;
- `cd` into a clone that's on main, then a bare `git push`.

**Asks are in memory.** The hook registers a pending ask, the UI shows it, and the hook awaits my
answer, then memoizes it (`api.memo`, first write wins). The hook runs before pi-durable commits the
tool's intent. After a restart it simply runs again and re-registers the ask: no persisted approval
state, no recovery path.

Every ask offers:
- **Allow**;
- **Always allow for <agent>**, which appends a rule to `rules.yaml`;
- **Deny with a note**, which goes back to the agent as the block reason. That's me saying no, not
  automation.

Asks come to me from every thread, delegated ones included. No agent is ever denied by a machine.

**Accountability.**
- Every judge decision goes to a JSONL log, shown as a feed in the UI.
- "That was wrong" on an entry tightens or loosens a rule.
- The evaluation set is `scripts/judge-eval/commands.ts`: 176 labeled commands, 34 of them held out.
  `npm run judge:eval` runs them through the real judge, and it's re-run whenever the question, the
  rules or the thresholds change. On 2026-10-06, 3 repeats gave:
  - **Jev:** 0 false runs, 2 false asks (an ansible run against dev, `gh label create`), and 0
    commands with disagreeing repeats.
  - **The Qwen fallback alone:** 0 false runs, 12 false asks, all toward asking.

## Memory

- `remember(note)` appends `- YYYY-MM-DD: note` to `$STOMP_STATE/notes/<agent>.md`, in the VM's
  state and not in git. Agent-written notes don't fight the desktop's copy of `~/.config/stomp`.
- The notebook is a section, so every thread of that agent sees it. It's seeded before the soul, so a
  change is a small in-place patch.
- I view and edit it in the UI, at `#/agent/<id>/notebook`.
- No screening, no holds.
- Past a size cap (150 lines), the tool asks the agent to tidy up with `notebook(text)`. Later, a Qwen
  duty could do it overnight.

## Web UI

React 19, Vite and Tailwind 4, lifting chat rendering (marked, shiki, dompurify) from onionsoup's
surface (MIT, OpenChamber styles).

- **Rail.** The supervisor pinned at the top, then agents with a status dot: idle, working,
  needs you. Each agent's recent threads sit underneath.
- **Thread.**
  - streaming text;
  - collapsible tool cards with an output tail;
  - inline cards for asks, reviews and delegations; a delegation card links to the thread;
  - a composer with send/steer and abort.
- **Work.** Threads grouped by derived state: needs you, working, reviewing, recently done. Also
  usage per provider for today.
- **Phone.** The rail becomes a drawer and Work becomes a tab. PWA install and push notifications
  come later.
- **Transport.**
  - `POST` handles submit, abort, new thread and answering asks.
  - One WebSocket carries live views: the base value, then `conv.watch()` Chord ops, applied with
    `applyImmutable` from `@earendil-works/chord/delta`. The spike measured 6 KB per reply on a
    150-turn thread, against 20 MB for whole views.
  - Older history comes from `conv.entries()`, paged. `viewState` holds only the active context.
- **Access.** Binds to 127.0.0.1; `tailscale serve` provides access and identity. No login system.

## pi-durable: what we use, what we build

| We use | We build |
|---|---|
| Ownerless conversations, SQLite storage, resume after restart | The browser bridge and the UI (nothing in the repo attaches a browser) |
| `configure` (model, instructions, extensions, tools, cwd) | Names (a doc mapping name → id) |
| Background tasks with phases (Delegation, Review) | Asks (a hook plus memo) |
| Task-owned ephemeral children (the reviewer) | The envelope (a VM; there's no sandbox) |
| Sections (house, soul, notebook, team) | A bash timeout wrapper (bash has no default timeout) |
| `beforeTool` hooks, `memo` | Family classification |
| Docs (`stomp.agents`, `stomp.threads`), `watchDoc` | `workspace`, `remember`, `verdict`, supervisor tools |
| `viewState`, `entries`, `usage`, `taskGraph` | |
| Hot-swapping extensions on file change | |

**Known sharp edges, with our response:**

| Edge | Response |
|---|---|
| 13 npm releases in 17 days; 1.0.3 and 1.0.4 both broke interfaces | Pin the exact version. Upgrade deliberately, reading the changelog. Keep our code small enough to port. |
| Compaction uses the thread's own model | Expensive models summarize their own threads. Later, `beforeCompact` can hand summaries to local Qwen. |
| Models without mid-conversation system messages fold sections into the top prompt | A changed section breaks their cache. Notebooks change rarely, and the Team section only when the team changes. |
| Progress commits every 100 ms | Raise `settings.progress` if SQLite write load shows up. |
| pi's own server speaks CBOR over a Unix socket; its WebSocket relay needs an Authorization header | Our own small bridge on node http plus `ws` (or Hono). |
| No delete; the store grows forever | Fine for months. Revisit with numbers. |
| No timestamps on entries (#10549) | Message entries carry `model[0].timestamp`. Only stomp's own entry kinds need an `at` field. |
| Wait cycles deadlock (#10411) | Never synchronously wait on a long-lived conversation. |
| Built-in tools don't declare `replay` | After a crash the agent is told the call was interrupted. That's the behavior we want. |
| Follow-ups queued behind a failed run wait for the next input, even across restarts | One level-triggered check: a thread that's idle with a non-empty inbox gets a nudge. That way a delegation report can't sit unread after a provider error. |
| bash children survive `kill -9` (they run detached) | systemd `KillMode=control-group`, and `close()` on SIGTERM. |
| No concurrency limit across agents | Several concurrent agents ran for minutes without provider errors. Add a per-provider limit only if a provider starts limiting. |
| The soul never reaches the top-level system prompt on Claude (#10542) | Seed it in `init`; verified in the spike. |

## Phases

Each phase ends with something I can do, checked by me in the real app.

**Phase 0: Spike** (done 2026-10-06, **go**: see [spike.md](spike.md)). Its throwaway code lived in `spike/` and was deleted once phases 1–5 replaced it. Toy
prompts on the desktop are fine here, since no agent does real work. Answer these, write them up in
a page in `docs/spike.md`, and decide go or no-go.

1. **Auth.**
   - Copilot device flow, ChatGPT sign-in and Claude Pro/Max through pi-ai `models.login` with a
     file credential store, compared with reusing `~/.pi/agent/auth.json` through `ModelRuntime`.
     pi-ai renamed the ChatGPT providers between your 0.84 CLI and 1.0.4.
   - Local Qwen as an OpenAI-compatible provider.
   - One request on each.
   - Claude: check claude.ai's usage page to see whether the requests count against the plan or
     against extra usage. Check that a soul still sets the voice under the forced Claude Code block.
2. **Persistence.** Three ownerless conversations on three providers in one Harness. `kill -9` the
   process mid-bash, restart, and check that the threads resume and the agent hears about the
   interruption.
3. **Async delegation.** Run example 23's pattern: the tool returns at once and the report arrives
   as a followUp. Repeat with the supervisor busy, and with a restart between deliver and report.
4. **Thread lifetime.** Does an ownerless thread created inside a task still take input after the
   task ends?
5. **Asks.** A `beforeTool` hook awaiting an in-memory promise for minutes. Restart while it waits:
   is it re-asked, and does the memo replay the answer?
6. **Browser.** Stream one conversation's `viewState` over a WebSocket to a bare page, and measure
   payload sizes on a long thread.
7. **Load.** Several concurrent agents for a few minutes: does any provider start limiting?
8. **Judge.** Run dish's live gate table through the single effect question and count the asks it
   would have caused.

No-go if delegation or the browser bridge needs more than about 300 lines of fighting the
framework, or if the subscriptions can't work without API keys.

**Phase 1: Agents in a browser.** (Done 2026-10-06, bketelsen/stomp#1.)
- **Built:**
  - the agent loader with house rules and souls; each agent gets a desk thread and "new thread";
    direct chat only, no delegation yet;
  - coding tools with a bash timeout; SQLite;
  - the streaming UI with steer and abort;
  - the four providers (Copilot, ChatGPT, Claude, local Qwen) behind aliases, with `stomp login`;
  - the VM, first as a local Incus VM. Moving it to a homelab host, with `tailscale serve`,
    follows once it works. It holds no host credentials.
- **Done when:** I use it instead of a terminal agent for a real small task, and restart the server
  mid-tool without losing anything.

**Phase 2: The team.** (Done 2026-10-06. Verified with real models in the VM: two delegations,
chatting meanwhile, both reports, and a steer mid-work that reached the report.)
- **Built:** subordinate agents; desk threads and new threads; `delegate`, `message`, `cancel`,
  `read`; the Delegation task; the Team section; the Work panel; usage.
- **The starting four**, each converted by hand from `~/.config/onionsoup/owners/<id>.yaml` (voice)
  and `charters/<id>.md` into one file of at most 60 lines, dropping process and fear text:

  | Agent | Role |
  |---|---|
  | Odrade | Supervisor |
  | Miles Teg | bketelsen/fleet and the Incus remotes |
  | Bellonda | bketelsen/homewiki |
  | Lucilla | The package and sysext repo group |

  Several of those charters are still marked "DRAFT written by Claude" in onionsoup's gaps.md, so
  this is the moment to rewrite them.
- **Done when:** I give the supervisor two jobs for two agents, keep chatting while they work, get
  both reports, and step into one thread to steer it.

**Phase 3: Cross-family review.** (Built 2026-10-06. In the VM, Teg on Copilot Claude was approved
by GPT, and Lucilla on GPT by Copilot Claude, whose two notes reached the report.)
- **Built:** `workspace` and worktrees; the level-triggered Review task; `verdict`; up to two fix
  rounds; review cards.
- **Done when:** a Claude-authored change gets a GPT review, a blocker goes back to the author
  automatically, and the report carries the verdict.
- **Later:**
  - worktree cleanup;
  - the verdict on PRs;
  - the reviewer's own thinking level;
  - the pool check for agents added after startup.

**Phase 4: Judge and asks.** (Built 2026-10-06. Verified live in the VM: allow rule, Jev clearing, ask rule, Jev asking, deny with a note, and a secret that stayed hidden.)
- **Built:** `rules.yaml`, Jev, inline ask cards, always-allow, the decision log; then scoped
  credentials for ops agents.
- **Done when:** after a week of real work, the median is zero asks per task and every ask was for
  something outward.

**Phase 5: Memory and life.**
- **Built:**
  - **Notebooks.** `remember` appends dated notes to `$STOMP_STATE/notes/<agent>.md`, which every
    thread of that agent sees as a prompt section. Brian views and edits it in the UI. Past a size
    cap, the tool asks the agent to consolidate.
  - **Consults.** Any agent can `consult` another. An ephemeral, task-owned copy of the other agent
    (its soul and notebook, read-only tools) answers in onionsoup's observed / inferred / unknown
    shape. It's not a team member, and nothing waits on a long-lived conversation.
  - **Duties.** An agent file can list duties as `{name, every, check, wake, brief}`.
    - Host code runs each `check` on schedule, as the level-triggered check "is a duty due?"; its
      last run is kept in a session doc.
    - It wakes the agent only when the output changed or the check failed.
    - The wake is a Delegation from the supervisor, so the finding comes back through Odrade's
      report. Without a supervisor it goes to the desk.
    - Agents see their own duties, and Odrade sees everyone's. She adds, replaces and removes her
      own with `duty`, in `$STOMP_STATE/duties.yaml`; the judge clears each check as she sets it.
      A duty without a check wakes the agent every time.
  - **Unread markers and notifications** for threads with new activity, derived in the browser.
- **Done when:** Miles Teg notices something in the homelab on his own and tells me.
- **Later:**
  - phone push and an installable PWA (they need the VM reachable from the phone, so they go with
    the move to a homelab host and `tailscale serve`);
  - Qwen for compaction summaries.

Size check: server about 2.5k lines and UI about 3.5–4k lines, against the 8k budget.

## Proposed layout (not created yet)

```
stomp/                          ~/.config/stomp/ (its own git repo)
  NORTHSTAR.md README.md          stomp.yaml   providers, families, review pool, judge
  FRICTION.md                     house.md     shared rules
  docs/plan.md docs/lessons.md    agents/*.md  one per agent
  src/server/  src/web/           notes/*.md   notebooks, written by agents
  scripts/budget.mjs              rules.yaml   judge rules
  examples/home/                (state: ~/.local/share/stomp/{stomp.sqlite,work/,judge.log})
```

One package, no monorepo. The server runs as `.ts` through Node 24's type stripping; only the UI has
a build.

## Decisions

Decided by Brian on 2026-10-06:

1. **Envelope.** An Incus VM from day one, like dish.
2. **Starting cast.** Four onionsoup owners, converted: Odrade (supervisor), Miles Teg, Bellonda,
   Lucilla.
3. **Supervisor.** Read-only tools (read, grep, fetch) plus delegation. Every change goes to an
   agent.
4. **Claude subscription.** Used through pi-ai's Claude login, behind model aliases, with the
   billing check in the spike.

Defaulted (say so to change):

5. **UI stack.** React, Vite and Tailwind, with onionsoup's chat rendering.
6. **Consults between agents.** Phase 5, read-only and ephemeral.
