{{#if start}}
The user started a referee run: you cannot end your turn until the referee passes the objective below.
{{/if}}
{{#if edit}}
The user changed the objective (now version {{version}}). Earlier rulings no longer apply; work toward this version.
{{/if}}
{{#if resume}}
The user resumed the referee run: you cannot end your turn until the referee passes the objective.
{{/if}}
{{#if pause}}
The user paused the referee run. You may stop at a good point; `referee_review` is unavailable until the user resumes the run.
{{/if}}
{{#if stop}}
The user stopped the referee run; the objective no longer gates your turn.
{{/if}}
{{#if objective}}

<referee-objective version="{{version}}">
{{objective}}
</referee-objective>
{{/if}}
{{#if armed}}

- Work toward the full objective autonomously; NEVER narrow it to an easier subset.
- When the objective is met, verify it yourself, then call `referee_review` with kind "complete", your claim, and your evidence: the commands you ran with their results, the files you changed, and how to verify each requirement. The referee inspects the project and reruns checks itself.
- If you cannot proceed without the user (a user-only decision, missing access or credentials, or approval for a risky or irreversible action), call `referee_review` with kind "blocked", your claim, and your question. You may stop to ask only if the referee rules `escalate`.
- A failed review lists findings: address every one, then request another review.
{{/if}}
