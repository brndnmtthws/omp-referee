/**
 * Tool contracts: the referee's `referee_verdict`, and the parameters and
 * validation of the main agent's `referee_review`. Code, not model prose,
 * decides what a verdict means; a rejected call surfaces to the model as a
 * tool error it can correct.
 *
 * Schemas use the host's `pi.arktype` builder so the host tool registry
 * validates them with its own runtime.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CustomTool, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import verdictDescription from "./prompts/tools/verdict.md" with { type: "text" };
import type { RefereeVerdictRecord, ReviewKind, Verdict } from "./types";

export const REVIEW_TOOL_NAME = "referee_review";
export const VERDICT_TOOL_NAME = "referee_verdict";

/** A verdict summary must say what was checked; one-word rulings are rejected. */
export const MIN_SUMMARY_CHARS = 30;

/** The review a `referee_verdict` call answers; the reviewer opens one per review. */
export interface VerdictSlot {
	review?: { index: number; kind: ReviewKind; verdict?: RefereeVerdictRecord };
}

export interface VerdictInput {
	verdict: Verdict;
	summary: string;
	findings?: string[];
}

export interface ReviewInput {
	kind: ReviewKind;
	claim: string;
	evidence?: string;
	question?: string;
}

/** The verdicts that answer each kind of claim. */
const ALLOWED_VERDICTS: Record<ReviewKind, readonly Verdict[]> = {
	complete: ["pass", "fail"],
	blocked: ["escalate", "fail"],
};

export function textResult(text: string, isError = false): AgentToolResult {
	return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/** Check a verdict against the claim it answers: the normalized record, or an error for the referee. */
export function validateVerdict(kind: ReviewKind, input: VerdictInput): RefereeVerdictRecord | string {
	const allowed = ALLOWED_VERDICTS[kind];
	if (!allowed.includes(input.verdict)) {
		const claim = kind === "complete" ? "A completion claim" : "A blocked claim";
		return `${claim} takes ${allowed.map(verdict => `\`${verdict}\``).join(" or ")}, not \`${input.verdict}\`.`;
	}
	const summary = input.summary.trim();
	if (summary.length < MIN_SUMMARY_CHARS) {
		return `The summary needs at least ${MIN_SUMMARY_CHARS} characters: say what you checked and how.`;
	}
	const findings = (input.findings ?? []).map(finding => finding.trim()).filter(Boolean);
	if (input.verdict === "fail" && findings.length === 0) {
		return "A `fail` needs at least one finding: what is unmet, the evidence, and what must change.";
	}
	return { verdict: input.verdict, summary, findings };
}

/** Check a review request from the main agent: the normalized input, or an error for the agent. */
export function validateReviewInput(input: ReviewInput): ReviewInput | string {
	const claim = input.claim.trim();
	if (!claim) return "`claim` is empty: say what you did, or what blocks you.";
	const normalized: ReviewInput = { kind: input.kind, claim };
	const evidence = input.evidence?.trim();
	if (evidence) normalized.evidence = evidence;
	const question = input.question?.trim();
	if (input.kind === "blocked") {
		if (!question) return "A blocked claim needs `question`: what you need from the user.";
		normalized.question = question;
	}
	return normalized;
}

/** Builds the `referee_verdict` tool for a reviewer; the schema is built once and shared. */
export function refereeVerdictToolkit(type: ExtensionAPI["arktype"]): (slot: VerdictSlot) => CustomTool {
	const schema = type({
		verdict: type("'pass' | 'fail' | 'escalate'").describe("your ruling"),
		summary: type("string").describe(`what you checked and how (>= ${MIN_SUMMARY_CHARS} chars)`),
		"findings?": type("string")
			.array()
			.describe("one per unmet requirement: what is unmet, the evidence, and what must change"),
	});
	return slot => {
		const tool: CustomTool<typeof schema> = {
			name: VERDICT_TOOL_NAME,
			label: "Referee verdict",
			description: prompt.render(verdictDescription),
			parameters: schema,
			approval: "read",
			loadMode: "essential",
			async execute(_toolCallId, params) {
				const review = slot.review;
				if (!review) return textResult("No review is open.", true);
				if (review.verdict) return textResult(`Your ruling for review ${review.index} is already recorded.`, true);
				const result = validateVerdict(review.kind, params);
				if (typeof result === "string") return textResult(result, true);
				review.verdict = result;
				return textResult(`Ruling recorded: ${result.verdict}.`);
			},
		};
		return tool;
	};
}
