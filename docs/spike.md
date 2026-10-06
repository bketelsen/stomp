# Spike results (phase 0, 2026-10-06)

**Verdict: go on pi-durable 1.0.4.** Every mechanic stomp needs worked with small glue and no
recovery code. Two no-go triggers were set: delegation or the browser bridge needing more than about
300 lines of fighting the framework, and subscriptions not working without API keys. Neither fired.

The spike's throwaway code was deleted once phases 1–5 replaced it; its findings are summarized
here, and the plan has every correction below.

| # | Question | Answer | Glue | What it changed |
|---|---|---|---|---|
| 2 | Crash recovery, many threads | Yes, with no recovery code. An interrupted bash reports "interrupted" to the model; an interrupted stream is re-sent; config survives. | ~80 | Follow-ups behind a failed run wait for the next input, so a level-triggered inbox nudge is needed. bash children survive `kill -9`, so systemd `KillMode=control-group`. |
| 3 | Async delegation | Yes, restart-safe at 5 kill points. Real Qwen supervisor → Qwen agent round trip in 23 s. | 153 | Report keyed on the answer; the report re-queues if Esc withdraws it; `cancel` goes through the Harness; the report carries the thread's latest answer. The wait-cycle rule was reworded. |
| 4 | Thread lifetime | Ownerless threads take input forever, after tasks end and after restarts. Task-owned threads stay tied to their owner's abort. | — | All threads are ownerless. |
| 5 | Durable asks | Yes. A restart while waiting re-asks with the same ids; a crash after the answer replays the memo. | 66 | The guard lives inside the bash extension; hooks wait with `awaitWithContext`, or abort hangs. |
| 6 | Browser bridge | Yes. About 8 updates a second, two clients in sync, reconnect in ~300 ms. | 211 + page | Use `conv.watch()` ops: 6 KB per reply versus 20 MB for whole views on a 150-turn thread. Message entries already carry timestamps. |
| 8 | Judge | Works after three changes. 0 asks for a coding task, 2 for ops, 0 false runs on 176 commands. Jev ~165 ms with 0 errors in 1,448 calls. | eval only | Summed-probability routing, boundary wording with both option orders, push and PR allow rules, `incus delete` and pipe-to-shell ask rules. Qwen logprob is the fallback; the keyword fallback was a hole. |
| 9 | Review loop (added) | Yes: trigger, fix rounds and cards, restart-safe. Qwen reviewed well: 10/10 correct `verdict` calls, every planted bug caught, no false blockers. | 345 | One attempt per HEAD; the card is written through the Harness; reviewers are configured explicitly; agents get explicit extension arrays. |
| 1 | Providers | All four routes work with tool calls: Copilot (Claude, GPT, Gemini), ChatGPT, the Claude subscription and local Qwen. Refresh is transparent. The Claude requests drew on the plan, not extra usage. | — | Souls never reach the top-level system prompt on Claude (#10542), so seed them in `init`. Copilot Claude needs thinking ≥ low. |
| 7 | Load | Several concurrent agents ran coding loops for minutes without provider errors. | — | No concurrency cap. One Gemini stream died with an unretried `finish_reason: error`, and one stalled for 73 s. |

## What we learned about pi-durable

- **Durability is real.** SIGKILL at any point, in any experiment, came back correct on the next
  open with no code of ours. That's the category that consumed most of onionsoup.
- **The sharp edges are all small and known.**
  - Hooks only run where their extension is selected, and a child's `{add, remove}` edits the host
    default, not its copy.
  - Tools can't abort tasks, and tasks can't make write submissions; both go through the host's
    Harness.
  - Esc withdraws queued input, delegation reports included.
  - Nothing times out: not runs, and not bash.
  - `harness.waitForIdle()` ignores background work.
  - Storage only grows: about 4 KB per tool-heavy turn, 11 MB for 3,000 turns, reopening in
    milliseconds.
- **Glue measured:** about 850 lines for delegation, asks, review, persistence and the bridge
  server, against the plan's 2.5k server estimate.
- **pi-ai edges:**
  - the soul-placement bug (#10542), with a verified workaround;
  - Copilot Claude rejects thinking "off";
  - `finish_reason: error` isn't retried.
- **Accounts differ from the catalog.** The models an account offers can differ from pi-ai's built-in
  catalog, so `stomp.yaml` can define a model the catalog doesn't know.

## Carried into phase 1

- The orphaned bash process groups and the missing timeouts are handled by the plan's defaults
  (systemd, the bash timeout, the UI's elapsed time and abort). Revisit only if they bite.
- Thinking-model latency: about 20 s per supervisor hop on local Qwen, and minutes if a brief
  invites deliberation.
- pi-durable's churn: pin 1.0.4 and upgrade deliberately.
