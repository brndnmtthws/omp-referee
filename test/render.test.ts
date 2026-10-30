import { describe, expect, it } from "bun:test";
import { stopBlockedReason } from "../src/render";
import { createRun } from "../src/run";
import type { RefereeRun, ReviewRecord } from "../src/types";

const SUMMARY = "Ran bun test and read a.txt; beta is not there yet.";

function freshRun(): RefereeRun {
	return createRun({ id: "run-1", objective: "Make a.txt say beta.", refereeModel: "fake/referee", now: 1 });
}

function record(run: RefereeRun, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
	return {
		index: run.reviews.length + 1,
		kind: "complete",
		outcome: "verdict",
		summary: SUMMARY,
		findings: [],
		objectiveVersion: run.objectiveVersion,
		startedAt: 2,
		durationMs: 10,
		tokens: 100,
		costUsd: 0.01,
		...overrides,
	};
}

describe("stop-blocked reason", () => {
	it("says no review has judged the objective yet", () => {
		const reason = stopBlockedReason(freshRun());
		expect(reason).toContain("The referee has not passed the objective");
		expect(reason).toContain("Make a.txt say beta.");
		expect(reason).toContain("No review has judged this objective yet");
	});

	it("carries the referee's ruling: outcome, summary, and findings", () => {
		const run = freshRun();
		run.reviews.push(record(run, { verdict: "fail", findings: ["a.txt still says alpha."] }));
		const reason = stopBlockedReason(run);
		expect(reason).toContain("review 1, fail");
		expect(reason).toContain(SUMMARY);
		expect(reason).toContain("- a.txt still says alpha.");
	});

	it("speaks for the newest review, not an older fail", () => {
		const run = freshRun();
		run.reviews.push(record(run, { verdict: "fail", findings: ["a.txt still says alpha."] }));
		run.reviews.push(record(run, { outcome: "error", summary: "injected referee outage" }));
		const reason = stopBlockedReason(run);
		expect(reason).toContain("review 2, the referee could not finish");
		expect(reason).toContain("injected referee outage");
		expect(reason).not.toContain("a.txt still says alpha.");
	});

	it("ignores reviews of an older objective version", () => {
		const run = freshRun();
		run.reviews.push(record(run, { verdict: "fail", findings: ["old finding"] }));
		run.objectiveVersion = 2;
		expect(stopBlockedReason(run)).toContain("No review has judged this objective yet");
	});

	it("escapes the objective and the referee's text", () => {
		const run = createRun({ id: "run-2", objective: "Make a < b && c > d.", refereeModel: "fake/referee", now: 1 });
		run.reviews.push(record(run, { verdict: "fail", findings: ['the command printed "<x>"'] }));
		const reason = stopBlockedReason(run);
		expect(reason).toContain("Make a &lt; b &amp;&amp; c &gt; d.");
		expect(reason).toContain("&lt;x&gt;");
	});
});
