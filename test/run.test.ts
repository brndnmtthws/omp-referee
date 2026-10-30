import { describe, expect, it } from "bun:test";
import {
	addSpend,
	budgetExhausted,
	createRun,
	decideStop,
	editObjective,
	MAX_REVIEW_ERRORS,
	parseRun,
	pauseRun,
	RUN_ENTRY_TYPE,
	recordReview,
	restoreRun,
	resumeRun,
	stopRun,
} from "../src/run";
import type { RefereeRun, ReviewKind, ReviewOutcome, ReviewRecord, Verdict } from "../src/types";

const STALL = 3;

function freshRun(): RefereeRun {
	return createRun({ id: "run-1", objective: "Make the build pass.", refereeModel: "fake/referee", now: 1 });
}

function review(
	run: RefereeRun,
	outcome: ReviewOutcome,
	options: { verdict?: Verdict; kind?: ReviewKind; version?: number; costUsd?: number } = {},
): ReviewRecord {
	return {
		index: run.reviews.length + 1,
		kind: options.kind ?? "complete",
		outcome,
		verdict: options.verdict,
		summary: "Checked the build output and the test results.",
		findings: options.verdict === "fail" ? ["The build still fails in src/a.ts."] : [],
		objectiveVersion: options.version ?? run.objectiveVersion,
		startedAt: 2,
		durationMs: 10,
		tokens: 100,
		costUsd: options.costUsd ?? 0.01,
	};
}

describe("stop gate", () => {
	it("blocks every stop of an active run until a pass", () => {
		let run = freshRun();
		const first = decideStop(run, true, STALL, 2);
		expect(first.action).toBe("block");
		run = recordReview(run, review(run, "verdict", { verdict: "fail" }), 3);
		expect(decideStop(run, true, STALL, 4).action).toBe("block");
		run = recordReview(run, review(run, "verdict", { verdict: "pass" }), 5);
		expect(run.status).toBe("passed");
		expect(decideStop(run, false, STALL, 6).action).toBe("allow");
	});

	it("pauses the run after the stall limit of tool-free stops in a row, and tool use resets the count", () => {
		let run = freshRun();
		for (let stop = 1; stop < STALL; stop++) {
			const decision = decideStop(run, false, STALL, stop);
			expect(decision.action).toBe("block");
			run = decision.run!;
		}
		const reset = decideStop(run, true, STALL, 10);
		expect(reset.action).toBe("block");
		expect(reset.run!.idleStops).toBe(0);
		run = reset.run!;
		for (let stop = 1; stop < STALL; stop++) run = decideStop(run, false, STALL, 10 + stop).run!;
		const stalled = decideStop(run, false, STALL, 20);
		expect(stalled.action).toBe("stall");
		expect(stalled.run!.status).toBe("paused");
		expect(stalled.run!.pauseReason).toBe("stalled");
		expect(decideStop(stalled.run, false, STALL, 21).action).toBe("allow");
	});

	it("lets exactly one stop through after an escalation, then holds the agent again", () => {
		let run = freshRun();
		run = recordReview(run, review(run, "verdict", { verdict: "escalate", kind: "blocked" }), 2);
		expect(run.status).toBe("active");
		const allowed = decideStop(run, false, STALL, 3);
		expect(allowed.action).toBe("allow");
		expect(decideStop(allowed.run, false, STALL, 4).action).toBe("block");
	});

	it("never blocks a paused, stopped, or missing run", () => {
		expect(decideStop(undefined, false, STALL, 1).action).toBe("allow");
		expect(decideStop(pauseRun(freshRun(), "user", 2), false, STALL, 3).action).toBe("allow");
		expect(decideStop(stopRun(freshRun(), 2), false, STALL, 3).action).toBe("allow");
	});
});

describe("reviews", () => {
	it("records a ruling on an older objective as stale without applying it", () => {
		let run = freshRun();
		const pending = review(run, "verdict", { verdict: "pass" });
		run = editObjective(run, "Make the build and the tests pass.", 2);
		run = recordReview(run, pending, 3);
		expect(run.status).toBe("active");
		expect(run.reviews.at(-1)!.outcome).toBe("stale");
	});

	it("does not count cancelled reviews toward the review budget", () => {
		let run = freshRun();
		run = recordReview(run, review(run, "aborted"), 2);
		expect(run.reviewsSinceResume).toBe(0);
		expect(budgetExhausted(run, { maxReviews: 1, stallLimit: STALL })).toBeUndefined();
		run = recordReview(run, review(run, "verdict", { verdict: "fail" }), 3);
		expect(budgetExhausted(run, { maxReviews: 1, stallLimit: STALL })).toBeTypeOf("string");
	});

	it("enforces the spend budget across reviews and status checks, and resuming starts it over", () => {
		let run = freshRun();
		run = recordReview(run, review(run, "verdict", { verdict: "fail", costUsd: 0.4 }), 2);
		run = addSpend(run, 0.2, 3);
		expect(run.costUsd).toBeCloseTo(0.6);
		expect(budgetExhausted(run, { maxCostUsd: 0.5, stallLimit: STALL })).toBeTypeOf("string");
		run = resumeRun(pauseRun(run, "budget", 4), 5);
		expect(budgetExhausted(run, { maxCostUsd: 0.5, stallLimit: STALL })).toBeUndefined();
		expect(run.costUsd).toBeCloseTo(0.6);
	});

	it(`pauses after ${MAX_REVIEW_ERRORS} referee errors in a row, and a ruling resets the count`, () => {
		let run = freshRun();
		for (let attempt = 1; attempt < MAX_REVIEW_ERRORS; attempt++)
			run = recordReview(run, review(run, "error"), attempt);
		run = recordReview(run, review(run, "verdict", { verdict: "fail" }), 10);
		expect(run.reviewErrors).toBe(0);
		for (let attempt = 1; attempt < MAX_REVIEW_ERRORS; attempt++)
			run = recordReview(run, review(run, "error"), 10 + attempt);
		expect(run.status).toBe("active");
		run = recordReview(run, review(run, "error"), 20);
		expect(run.status).toBe("paused");
		expect(run.pauseReason).toBe("error");
	});
});

describe("objective edits", () => {
	it("bumps the version and voids a pending escalation", () => {
		let run = freshRun();
		run = recordReview(run, review(run, "verdict", { verdict: "escalate", kind: "blocked" }), 2);
		const edited = editObjective(run, "  Make the build pass on CI.  ", 3);
		expect(edited.objective).toBe("Make the build pass on CI.");
		expect(edited.objectiveVersion).toBe(2);
		expect(decideStop(edited, true, STALL, 4).action).toBe("block");
	});

	it("keeps the run for an unchanged objective and rejects empty or finished ones", () => {
		const run = freshRun();
		expect(editObjective(run, "Make the build pass.", 2)).toBe(run);
		expect(() => editObjective(run, "   ", 2)).toThrow("empty");
		expect(() => editObjective(stopRun(run, 2), "Something else.", 3)).toThrow("over");
	});
});

describe("journal", () => {
	it("restores the newest snapshot on the branch, field for field", () => {
		let run = freshRun();
		run = recordReview(run, review(run, "verdict", { verdict: "fail" }), 2);
		run = pauseRun(run, "user", 3);
		const older = { type: "custom", customType: RUN_ENTRY_TYPE, data: JSON.parse(JSON.stringify(freshRun())) };
		const newest = { type: "custom", customType: RUN_ENTRY_TYPE, data: JSON.parse(JSON.stringify(run)) };
		const restored = restoreRun([older, { type: "message" }, newest, { type: "custom", customType: "other" }]);
		expect(restored).toEqual(run);
	});

	it("rejects malformed snapshots", () => {
		const good = JSON.parse(JSON.stringify(freshRun())) as Record<string, unknown>;
		expect(parseRun({ ...good, status: "constructor" })).toBeUndefined();
		expect(parseRun({ ...good, objective: "  " })).toBeUndefined();
		expect(parseRun({ ...good, reviews: [{ index: 1 }] })).toBeUndefined();
		expect(parseRun({ ...good, reviewErrors: -1 })).toBeUndefined();
	});
});
