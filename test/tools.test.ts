import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { refereeVerdictToolkit, validateReviewInput, validateVerdict, type VerdictSlot } from "../src/tools";

const SUMMARY = "Ran bun test and read src/a.ts; every requirement holds.";

describe("verdict validation", () => {
	it("only accepts the rulings that answer the claim", () => {
		expect(validateVerdict("complete", { verdict: "escalate", summary: SUMMARY })).toContain("`pass` or `fail`");
		expect(validateVerdict("blocked", { verdict: "pass", summary: SUMMARY })).toContain("`escalate` or `fail`");
		expect(validateVerdict("blocked", { verdict: "escalate", summary: SUMMARY })).toEqual({
			verdict: "escalate",
			summary: SUMMARY,
			findings: [],
		});
	});

	it("requires a substantive summary and, for a fail, at least one non-blank finding", () => {
		expect(validateVerdict("complete", { verdict: "pass", summary: "  looks good  " })).toContain("at least 30");
		expect(validateVerdict("complete", { verdict: "fail", summary: SUMMARY, findings: ["  ", ""] })).toContain(
			"at least one finding",
		);
		expect(
			validateVerdict("complete", { verdict: "fail", summary: SUMMARY, findings: [" tests fail ", " "] }),
		).toEqual({
			verdict: "fail",
			summary: SUMMARY,
			findings: ["tests fail"],
		});
	});
});

describe("review requests", () => {
	it("needs a claim, and a question for a blocked claim", () => {
		expect(validateReviewInput({ kind: "complete", claim: "  " })).toContain("`claim` is empty");
		expect(validateReviewInput({ kind: "blocked", claim: "Need the API key." })).toContain("needs `question`");
		expect(
			validateReviewInput({
				kind: "blocked",
				claim: " Need the API key. ",
				question: " Which key? ",
				evidence: " ",
			}),
		).toEqual({ kind: "blocked", claim: "Need the API key.", question: "Which key?" });
	});
});

describe("referee_verdict tool", () => {
	const makeTool = refereeVerdictToolkit(type);

	async function call(slot: VerdictSlot, params: { verdict: "pass" | "fail" | "escalate"; summary: string }) {
		// The tool reads only its slot; it never touches the session context.
		const result = await makeTool(slot).execute("call-1", params, undefined, undefined as never);
		return {
			error: result.isError === true,
			text: result.content.map(block => ("text" in block ? block.text : "")).join(""),
		};
	}

	it("records one ruling for the open review and rejects later ones", async () => {
		const slot: VerdictSlot = { review: { index: 2, kind: "complete" } };
		expect(await call(slot, { verdict: "pass", summary: SUMMARY })).toEqual({
			error: false,
			text: "Verdict recorded: pass.",
		});
		expect(slot.review?.verdict?.verdict).toBe("pass");
		const second = await call(slot, { verdict: "fail", summary: SUMMARY });
		expect(second.error).toBe(true);
		expect(slot.review?.verdict?.verdict).toBe("pass");
	});

	it("refuses a ruling when no review is open, and leaves an invalid ruling unrecorded", async () => {
		expect((await call({}, { verdict: "pass", summary: SUMMARY })).error).toBe(true);
		const slot: VerdictSlot = { review: { index: 1, kind: "complete" } };
		expect((await call(slot, { verdict: "escalate", summary: SUMMARY })).error).toBe(true);
		expect(slot.review?.verdict).toBeUndefined();
	});
});
