# omp-referee

`/referee <objective>` puts the agent in [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) on one objective and keeps it there until a second model, the referee, inspects the project and rules that the objective is met. It works like omp's goal mode, except the agent cannot declare itself done: every attempt to stop sends it back to work until the referee passes the objective. It is a plain omp extension: the stock `omp` binary loads it, and nothing in omp is patched.

Like omp's advisor, the referee is an independent model with its own session, read-only tools, and transcript. Unlike the advisor, it does not comment on the conversation: it judges the project against the objective, and its ruling decides whether the agent may stop.

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
/referee set [objective]      # the same, for an objective that starts with a subcommand word (no text: open the editor)
/referee edit [objective]     # change the objective (no text: open the editor)
/referee status [question]    # ask the referee where the objective stands, without interrupting the agent
/referee show                 # show the objective, the run's state, and every review
/referee pause                # let the agent stop until you resume
/referee resume               # hold the agent to the objective again
/referee stop                 # end the run
/referee model [selector]     # choose the referee model (`default` restores the default)
/referee                      # menu with all of the above, plus budgets
```

While a run is live, the status line shows its state, review count, and referee spend. During a review it shows the referee's current step instead, with the elapsed time once a step runs past 5 seconds, and any provider retry or context compaction. Run changes (objective set or edited, paused, resumed, stopped) appear in the conversation as cards, and each review shows its ruling and findings.

`/referee status` works like `/btw`: the referee inspects the project in a separate session and answers in a panel above the editor while the agent keeps working. The answer never enters the conversation. Esc closes the panel, or cancels a status check that is still running. In the TUI, `/referee show` uses the same panel.

Runs also work headless: `omp -p "/referee <objective>"` returns once the agent may stop, which happens when the referee passes the objective, rules **escalate** on a blocked claim, or the run pauses.

Write the objective as the contract: the referee fails anything it cannot verify, and it neither narrows the objective nor adds to it. Checkable criteria ("`bun test` passes", "`bun run check` exits 0") make for fast, decisive reviews.

- Referee transcript: `history://Referee` (`Referee-2` and so on when a session holds several)
- Status check transcript, while the check runs: `history://RefereeStatus` (`RefereeStatus-2` and so on)

## How it works

1. **Work:** The agent works toward the objective. Whenever it tries to end its turn, a stop hook sends it back with the objective restated and the referee's newest word on it: the summary and findings of the latest review, or a note that no review has judged this version yet.
2. **Review:** When the agent believes the objective is met, it calls `referee_review` with `kind: "complete"`, its completion claim, and evidence. The referee inspects the project in its own session: it reads files, runs diagnostics and tests with `bash`, and gathers its own evidence. It sees the objective, the claim, and the project, never the agent's conversation, and records its ruling with `referee_verdict` (nudged up to 2 times if its turn ends without one):
   - **pass:** the run ends and the agent may stop.
   - **fail:** the agent receives the findings (what is unmet, the evidence, and what must change) and keeps working. Calling `referee_review` again after a fail without running another tool first is refused; an errored or cancelled review can be retried right away.
3. **Blocked:** When the agent cannot continue without you (a decision only you can make, missing credentials, approval for a risky action), it calls `referee_review` with `kind: "blocked"`, its blocked claim, and `question`. If the referee agrees, it rules **escalate** and allows the next stop so the agent can ask you; otherwise it rules **fail** with how to proceed. The run stays active, so once you answer, the agent continues toward the objective.

The referee keeps one session per run, so later reviews re-check earlier findings and the full objective; switching the referee model starts a new session. Editing the objective bumps its version, voids rulings on older versions (including an unused escalation), and cancels any review in flight. When the agent's context is compacted, the compaction is told to keep the objective verbatim.

### Stopping and limits

- **Esc:** Interrupts the agent at any time. The run stays active, so the next turn you start is held to the objective again. Run `/referee pause` to chat freely.
- **Stalls:** After 3 blocked stops in a row with no progress in between, the run pauses (`stallLimit`). Progress means a tool call or a review that actually ran; a refused review does not count.
- **Referee errors:** After 3 reviews in a row that end in an error rather than a ruling, the run pauses. The referee never falls back to another model, even when omp's retry fallback is on, so every ruling comes from the model you chose. Switch models with `/referee model` if needed, then run `/referee resume`.
- **Budgets:** Optional caps on reviews (`maxReviews`) and referee spend (`maxCostUsd`) per active stretch of a run. When a budget is reached, the next `referee_review` pauses the run and tells the agent to report where things stand. Cancelled reviews do not count toward `maxReviews`; status checks count toward `maxCostUsd`. `/referee resume` starts the budgets and the error count over.
- **Reopened sessions:** Every run change is journaled in the session. A run that was active when omp exited or switched sessions comes back paused; branching or navigating the session tree keeps the branch's run state as is.
- **Plan and goal modes:** A run cannot start while omp's plan or goal mode is active. If you enter plan mode during a run, stops are let through until you leave plan mode.

## Configuration

Saved to `~/.omp/agent/referee.json` (the active profile's agent dir), shared by every project. `/referee model` and the `/referee` menu edit the model and budgets; hand edits are fine:

```json
{
	"model": "openai/gpt-5.2:high",
	"instructions": "Run the full test suite before every pass.",
	"maxReviews": 10,
	"maxCostUsd": 5,
	"stallLimit": 3
}
```

- **`model`:** Any model selector with credentials (`provider/id`, a role alias, optional `:thinking` suffix).
- **`instructions`:** Extra guidance appended to the referee's system prompt.
- **`maxReviews`, `maxCostUsd`:** Caps per active stretch of a run; unset or `0` means unlimited. Status checks count toward `maxCostUsd`.
- **`stallLimit`:** Blocked stops in a row without progress before the run pauses; default `3`.

Without `model`, the referee uses omp's advisor role: a configured `modelRoles.advisor` as is; otherwise the first available model in the advisor role chain (the `slow` role, then omp's built-in list) from a different family than the agent's model, since another family tends to catch different mistakes. If none is from another family, it takes the chain's first model, and with no chain at all, the agent's model.

## Safety

The referee gets read-only file, search, AST, and web tools (`read`, `grep`, `glob`, `ast_grep`, `web_search`), `bash` for diagnostics, and `referee_verdict` (review sessions only). It has no edit or write tools, and its instructions forbid modifying the project (scratch files go in `mktemp -d`). `bash` is omp's stock tool, so this boundary is an instruction, not a sandbox. Other agents cannot message the referee's session, so the agent cannot steer a ruling outside `referee_review`.

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
