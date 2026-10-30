# Status check
{{#if question}}

The user asks:

<question>
{{question}}
</question>
{{/if}}

<objective version="{{objectiveVersion}}">
{{objective}}
</objective>

<reviews>
{{reviews}}
</reviews>
{{#if activity}}

<agent-activity>
Recent conversation between the user and the agent, newest last:

{{activity}}
</agent-activity>
{{/if}}

Inspect the project as needed, then answer{{#if question}} the question{{/if}} in concise markdown: what is done (with evidence), what remains, and any risks or blockers.
