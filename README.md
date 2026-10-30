# omp-referee

`/referee <objective>` puts the agent in [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) on one objective and keeps it there until a second model, the referee, checks the project and rules that the objective is met. It works like omp's goal mode, except the agent cannot declare itself done: every attempt to stop sends it back to work until the referee passes the objective. It is a plain omp extension: the stock `omp` binary loads it, and nothing in omp is patched.

The referee works much like omp's advisor: an independent model in its own session, with read-only tools and its own transcript. Two things differ. It judges the project against the objective rather than reviewing the conversation as it goes, and it rules through a tool whose verdict gates the agent's turn.

## Install

```sh
# From npm
omp plugin install omp-referee

# From GitHub (append a tag such as #v0.1.0 to pin a release; a pinned install is not auto-updated)
omp plugin install github:brndnmtthws/omp-referee

# From a local checkout for development (edits apply on the next omp restart)
omp plugin link /path/to/omp-referee
```

Restart omp afterwards; extensions load at startup. `omp plugin list` shows `omp-referee`; `omp plugin uninstall omp-referee` removes it.

## Usage

```text
/referee <objective>          # start a run; the agent begins at once
/referee set <objective>      # the same, for an objective that starts with a subcommand word
/referee edit [objective]     # change the objective (no text: open it in the editor)
/referee status [question]    # ask the referee where things stand, without interrupting the agent
/referee show                 # the objective, the run's state, and every review
/referee pause                # let the agent stop; /referee resume re-arms the run
/referee stop                 # end the run
/referee model [selector]     # choose the referee model (`default` restores the default)
/referee                      # menu with all of the above, plus budgets
```

While a run is live, the status line shows its state, review count, and referee spend, and the referee's current step while it reviews. Run changes (objective set or changed, paused, resumed, stopped) appear in the conversation as cards, and each review shows its ruling and findings.

`/referee status` works like `/btw`: the referee inspects the project in a separate session and answers in a panel above the editor, while the agent keeps working. The answer never enters the conversation. Esc closes the panel, or cancels a check that is still running.

Runs also work headless: `omp -p "/referee <objective>"` returns once the agent may stop, when the referee passes the objective, agrees the agent needs you, or the run pauses.

Write the objective as the contract: the referee fails anything it cannot verify, and it neither narrows the objective nor adds to it. Checkable success criteria ("`bun test` passes", "`check.sh` exits 0") make for quick reviews.

## How a run works

1. **Work.** The agent works toward the objective. Whenever it tries to end its turn, a stop hook sends it back with the objective restated and the referee's latest word on it: the ruling summary, why it failed, and what must change. Before any review, it says no review has judged the objective yet.
2. **Review.** When the agent believes the objective is met, it calls `referee_review` with its claim and evidence. The referee checks the actual project state against every requirement: it reads files, reruns tests, and gathers its own evidence. It sees the objective, the claim, and the project, not the conversation. It rules through a tool, so code reads the ruling:
   - **pass:** the run ends and the agent may stop.
   - **fail:** the agent gets the findings and keeps working. Asking again without running any tool since the fail is refused; a review the referee could not finish can be retried right away.
3. **Blocked.** When the agent cannot continue without you (a decision only you can make, missing access, approval for a risky step), it calls `referee_review` with its question. If the referee agrees, it rules **escalate** and the agent may stop to ask; otherwise it rules **fail** and says how to proceed. The run stays active, so once you answer, the agent continues toward the objective.

The referee keeps one session per run, so later reviews re-check its earlier findings. Its transcript is at `history://Referee` (`Referee-2` and so on when a session holds several). Editing the objective voids rulings on the old version, including an escalation, and cancels a review in flight.

## Stopping

- **Esc** interrupts the agent at any time. The run stays active: the next turn you start is held to the objective again. Pause the run to chat freely.
- **Stalls:** after 3 stops in a row with no progress in between (no tool call, and no review that actually ran), the run pauses instead of sending the agent back again.
- **Referee failures:** after 3 reviews in a row that the referee fails to finish (a provider outage, for example), the run pauses. Switch the model with `/referee model`, then resume.
- **Budgets:** optional caps on reviews and on referee spend. When one is reached, the run pauses and the agent is told to report where things stand. Resuming starts the budgets over.
- **Reopened sessions:** a run that was active when omp exited comes back paused.

In the TUI, stops are let through while plan mode is active, and a run cannot start while plan or goal mode is on.

## Configuration

Saved to `~/.omp/agent/referee.json` (the active profile's agent dir), shared by every project. The menu edits the model and budgets; hand edits are fine:

```json
{
	"model": "openai/gpt-5.2:high",
	"instructions": "Run the full test suite before every pass.",
	"maxReviews": 10,
	"maxCostUsd": 5,
	"stallLimit": 3
}
```

- **`model`:** any model selector with credentials, including a `:thinking` suffix or a role alias.
- **`instructions`:** extra guidance for the referee.
- **`maxReviews`, `maxCostUsd`:** caps per active stretch of a run; unset or 0 means unlimited. Status checks count toward the spend.
- **`stallLimit`:** tool-free stops in a row before the run pauses; default 3.

Without a `model`, the referee uses omp's advisor role. A configured `modelRoles.advisor` is used as is. Otherwise the referee takes the first model of the advisor role's chain (the `slow` role, then omp's built-in list) from a different family than the main model, because a reviewer from another family misses different things. Failing that, it uses the main model.

## Safety

The referee gets read-only file, search, AST, and web tools (`read`, `grep`, `glob`, `ast_grep`, `web_search`), `bash` for diagnostics, and its ruling tool. It has no edit or write tools, and its instructions forbid modifying the project (scratch files go in `mktemp -d`). `bash` is omp's stock tool, so this boundary is an instruction, not a sandbox.

## Compatibility

omp has no stable plugin API covering what the referee needs, so `omp-referee` imports omp's internal modules directly, e.g. `@oh-my-pi/pi-coding-agent/config/model-resolver`, `.../registry/agent-registry`, `.../session/session-context`, `.../task/output-manager`. Any omp release may change them.

Tested with omp 18.14.0; the `@oh-my-pi/pi-coding-agent` devDependency in `package.json` pins the tested version. A newer omp can break the plugin until it is updated; when that happens, open an issue that includes your `omp --version`.

At runtime the omp binary serves its own bundled copies of these modules; the dev dependencies only provide types and test fixtures.

## Develop

```sh
bun install
bun run check   # type-check against the omp packages, lint, format check
bun test
```

`omp plugin link .` from the checkout runs it in your omp. To test against another omp release, set the `@oh-my-pi/pi-coding-agent` devDependency to that version.

### Releasing

Releases publish to npm from CI, never by hand. Bump `version` in `package.json`, commit and push to `main`, then create a GitHub release:

```sh
gh release create v<version> --generate-notes
```

Publishing the GitHub release runs the Release workflow (`.github/workflows/release.yml`). It fails unless the release tag is `v` plus the `package.json` version, runs `bun run check` and `bun test`, then publishes through npm trusted publishing: no npm token is stored, and npm attaches provenance. A version that is already on npm is skipped.

## License

MIT (see `LICENSE`).
