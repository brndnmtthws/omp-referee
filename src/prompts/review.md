# Review {{index}}: {{#if blocked}}blocked claim{{else}}completion claim{{/if}}
{{#if objectiveChanged}}

The user changed the objective since your last review. Judge against this version only.
{{/if}}

<objective version="{{objectiveVersion}}">
{{objective}}
</objective>
{{#if history}}

<earlier-reviews>
{{history}}
</earlier-reviews>
{{/if}}

<claim>
{{claim}}
</claim>
{{#if evidence}}

<evidence>
{{evidence}}
</evidence>
{{/if}}
{{#if question}}

<question-for-user>
{{question}}
</question-for-user>
{{/if}}

Investigate the current project state yourself, then record your ruling with `referee_verdict`: {{#if blocked}}`escalate` or `fail`{{else}}`pass` or `fail`{{/if}}.
