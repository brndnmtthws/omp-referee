/** Text and markdown renderings shared by the prompts, the status line, the panel, and the review tool. */
import { escapeXmlText, formatDuration, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import stopBlockedPrompt from "./prompts/stop-blocked.md" with { type: "text" };
import { MAX_REVIEW_ERRORS } from "./run";
import type { PauseReason, RefereeActivity, RefereeRun, ReviewOutcome, ReviewRecord, Verdict } from "./types";

/** An activity older than this shows its age, so a stalled request reads as stalled. */
const SHOW_ACTIVITY_AGE_MS = 5_000;

export const VERDICT_LABELS: Record<Verdict, string> = { pass: "PASS", fail: "FAIL", escalate: "ESCALATE" };

const PAUSE_LABELS: Record<PauseReason, string> = {
	user: "paused",
	restored: "paused since the session was reopened",
	stalled: "paused: the agent kept stopping without doing anything",
	budget: "paused: budget reached",
	error: "paused: the referee kept failing",
};

export function oneLine(text: string, width: number): string {
	const flat = sanitizeText(text).replace(/\s+/g, " ").trim();
	return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

export function formatCost(usd: number): string {
	if (usd <= 0) return "$0";
	return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** `active`, `passed`, `paused: budget reached`, … */
export function runStatusLabel(run: RefereeRun): string {
	return run.status === "paused" ? PAUSE_LABELS[run.pauseReason ?? "user"] : run.status;
}

/** `2 reviews · $0.42` */
export function runUsageLabel(run: RefereeRun): string {
	const reviews = run.reviews.filter(review => review.outcome !== "aborted").length;
	return `${reviews} review${reviews === 1 ? "" : "s"} · ${formatCost(run.costUsd)}`;
}

/** What the referee is doing right now, e.g. `bash bun test 12s`. */
export function activityLabel(activity: RefereeActivity, now = Date.now()): string {
	let label: string;
	if (activity.state === "tool" && activity.tool) {
		label = `${activity.tool}${activity.detail ? ` ${oneLine(activity.detail, 60)}` : ""}`;
	} else if (activity.state === "retrying") {
		label = `retrying ${oneLine(activity.detail ?? "", 60)}`.trimEnd();
	} else if (activity.state === "compacting") {
		label = "compacting context";
	} else {
		label = activity.state;
	}
	const age = now - activity.since;
	return age >= SHOW_ACTIVITY_AGE_MS ? `${label} ${formatDuration(age)}` : label;
}

/** The status line: `referee · active · 2 reviews · $0.42`, or the referee's current step during a review. */
export function statusLineText(run: RefereeRun, activity?: RefereeActivity): string {
	if (activity) return `referee · reviewing · ${activityLabel(activity)}`;
	return `referee · ${run.status === "paused" ? "paused" : run.status} · ${runUsageLabel(run)}`;
}

/** One review as a markdown list item, with its findings nested. */
function reviewItem(review: ReviewRecord): string {
	const claim = review.kind === "complete" ? "completion claim" : "blocked claim";
	const result =
		review.outcome === "verdict" && review.verdict
			? `**${review.verdict}**`
			: review.outcome === "stale"
				? "**stale** (objective changed)"
				: `**${review.outcome}**`;
	const lines = [`- Review ${review.index} (${claim}, objective v${review.objectiveVersion}): ${result}`];
	if (review.summary) lines[0] += ` — ${oneLine(review.summary, 400)}`;
	for (const finding of review.findings) lines.push(`  - ${oneLine(finding, 400)}`);
	return lines.join("\n");
}

/** Every review as a markdown list, oldest first. */
export function reviewDigest(reviews: readonly ReviewRecord[]): string {
	return reviews.length > 0 ? reviews.map(reviewItem).join("\n") : "No reviews yet.";
}

/** `/referee show`: the objective, the run's state, and every review. */
export function runOverview(run: RefereeRun): string {
	const quoted = run.objective
		.split("\n")
		.map(line => (line ? `> ${line}` : ">"))
		.join("\n");
	return [
		`**Objective** (v${run.objectiveVersion}):`,
		"",
		quoted,
		"",
		`**Run:** ${runStatusLabel(run)} · referee ${run.refereeModel} · ${runUsageLabel(run)}`,
		"",
		"**Reviews**",
		"",
		reviewDigest(run.reviews),
	].join("\n");
}

/** What `referee_review` tells the main agent once a review ends; `run` is the run after recording it. */
export function reviewResultText(run: RefereeRun, review: ReviewRecord): string {
	switch (review.outcome) {
		case "verdict":
			if (review.verdict === "pass") {
				return `The referee passed the objective (review ${review.index}).\n\n${review.summary}\n\nThe referee run is complete and no longer gates your turn. Report the outcome to the user and stop.`;
			}
			if (review.verdict === "escalate") {
				return `The referee agrees you need the user (review ${review.index}).\n\n${review.summary}\n\nAsk the user your question and stop; your next stop is allowed. The run stays active: once the user answers, continue toward the objective.`;
			}
			return [
				`The referee failed review ${review.index}.`,
				review.summary,
				`Findings:\n${review.findings.map(finding => `- ${finding}`).join("\n")}`,
				"Address every finding and verify the result yourself, then call `referee_review` again. You cannot stop until the referee passes the objective.",
			].join("\n\n");
		case "stale":
			return `The user changed the objective during review ${review.index}, so its ruling no longer applies. Work toward the current version, then request a new review:\n\n<referee-objective version="${run.objectiveVersion}">\n${escapeXmlText(run.objective)}\n</referee-objective>`;
		case "aborted":
			if (run.status === "paused")
				return "The user paused the referee during the review. You may stop when you reach a good point.";
			if (run.status === "stopped")
				return "The user stopped the referee run; the objective no longer gates your turn.";
			return `Review ${review.index} was cancelled.`;
		case "error":
			if (run.status === "paused") {
				return `The referee could not finish review ${review.index}: ${review.summary}\n\nThe referee failed ${MAX_REVIEW_ERRORS} reviews in a row, so the run is paused. Stop and tell the user; they can fix the referee and resume the run.`;
			}
			return `The referee could not finish review ${review.index}: ${review.summary}\n\nRequest the review again.`;
	}
}

/** How a review that produced no ruling reads inside the referee-feedback block. */
const FEEDBACK_LABELS: Record<ReviewOutcome, string> = {
	verdict: "ruling",
	stale: "stale ruling",
	error: "the referee could not finish",
	aborted: "cancelled",
};

/**
 * The reason a blocked stop carries back to the main agent: the objective, then
 * the referee's newest word on it (summary and findings), so a failed or
 * unfinished review says why the agent cannot stop and what to fix.
 */
export function stopBlockedReason(run: RefereeRun): string {
	const latest = run.reviews.at(-1);
	const review = latest?.objectiveVersion === run.objectiveVersion ? latest : undefined;
	const outcome = review
		? review.outcome === "verdict" && review.verdict
			? review.verdict
			: FEEDBACK_LABELS[review.outcome]
		: undefined;
	const feedback = review ? [review.summary, ...review.findings.map(finding => `- ${finding}`)].join("\n") : undefined;
	return prompt.render(stopBlockedPrompt, {
		version: run.objectiveVersion,
		objective: escapeXmlText(run.objective),
		review: review?.index,
		outcome,
		feedback: feedback ? escapeXmlText(feedback) : undefined,
	});
}
