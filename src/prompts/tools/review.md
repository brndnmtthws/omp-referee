Request a referee review of the active objective. The referee inspects the project and reruns checks in its own session; it sees only what you pass here, not your conversation. Verify your work before calling this tool.

- `kind: "complete"`: you claim the objective is met. `pass` ends the run; `fail` returns findings to fix.
- `kind: "blocked"`: you claim you cannot proceed without the user. `escalate` lets you stop once to ask; `fail` explains how to proceed on your own.
- `claim`: what you did and why it meets every requirement of the objective, or what blocks you.
- `evidence`: commands you ran with their results, files changed, and how to verify each requirement.
- `question` (blocked only): what you need from the user.
