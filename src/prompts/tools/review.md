Ask the referee to rule on the active objective. The referee is an independent model that inspects the project and reruns checks itself; it does not see your conversation, only what you send here.

- `kind: "complete"`: you believe the objective is achieved. `pass` ends the run; `fail` lists what is unmet.
- `kind: "blocked"`: you cannot proceed without the user. `escalate` lets you stop and ask; `fail` means you can proceed, and says how.
- `claim`: what you did and why it satisfies every requirement of the objective, or exactly what blocks you.
- `evidence`: the commands you ran with their results, the files you changed, and how to verify each requirement.
- `question` (blocked only): what you need from the user.

A review can take minutes. Verify the work yourself before asking: a failed review costs time.
