The referee has not passed the objective, so you cannot stop yet.

<referee-objective version="{{version}}">
{{objective}}
</referee-objective>
{{#if feedback}}

The referee's last word on this objective (review {{review}}, {{outcome}}):
<referee-feedback>
{{feedback}}
</referee-feedback>
{{else}}

No review has judged this objective yet.
{{/if}}

Keep working toward the objective. When it is met, verify it yourself and call `referee_review` with kind "complete" and your evidence. If you cannot continue without the user, call it with kind "blocked" and your question.
