{{#if start}}
The user started a referee run: an independent model, the referee, verifies the objective below, and you cannot end your turn until it passes.
{{/if}}
{{#if edit}}
The user changed the referee objective (now version {{version}}). Earlier rulings no longer apply; work toward this version.
{{/if}}
{{#if resume}}
The user resumed the referee run: you cannot end your turn until the referee passes the objective.
{{/if}}
{{#if pause}}
The user paused the referee run. You may stop when you reach a good point; `referee_review` is unavailable until the user resumes.
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

- Work toward the objective autonomously. Keep the full objective; NEVER narrow it to an easier subset.
- When you believe it is met, verify it yourself, then call `referee_review` with kind "complete", your claim, and evidence: the commands you ran with their results, the files you changed, and how to verify each requirement. The referee inspects the project and reruns checks on its own.
- If you cannot continue without the user (a decision only they can make, missing access, approval for a risky or irreversible action), call `referee_review` with kind "blocked" and your question. You may stop to ask only if the referee agrees.
- A failed review lists findings: address every one, then request another review.
{{/if}}
