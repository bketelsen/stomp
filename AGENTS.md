# Working on stomp

Read [NORTHSTAR.md](NORTHSTAR.md) first. It wins over anything else here. The plan is
[docs/plan.md](docs/plan.md), and the evidence behind both is in [docs/lessons.md](docs/lessons.md)
and [docs/spike.md](docs/spike.md).

- **Changes.** Every change says what Brian can do now that he couldn't before. A guard needs an
  incident, not a hypothetical. Delete what you replace.
- **Budgets.** `npm run budget` checks them. Exceeding one is Brian's decision, not a side effect.
- **Review.** Cross-family, once per PR, blockers only. A blocker is a bug Brian would hit in normal
  use, or data loss.
- **Friction.** It goes in [FRICTION.md](FRICTION.md), one line each. The usual fix is deletion.
- **Brian's agents.** Real agent files live in `~/.config/stomp`, never in this repository.
  `examples/home` is a starter.
- **Deploys.** Brian deploys. Don't touch running services unless asked.
- **Credentials.** Never print, log or commit credential values.
