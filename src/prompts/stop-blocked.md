The referee has not passed the objective, so you cannot stop yet.

<referee-objective version="{{version}}">
{{objective}}
</referee-objective>
{{#if feedback}}

Review {{review}} ({{outcome}}) is the latest on this objective:
<referee-feedback>
{{feedback}}
</referee-feedback>
{{else}}

No review has judged this objective yet.
{{/if}}

Keep working toward the objective. When it is met, verify it yourself and call `referee_review` with kind "complete", your claim, and your evidence. If you cannot proceed without the user, call it with kind "blocked", your claim, and your question.
