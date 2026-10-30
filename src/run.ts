/**
 * The referee run state machine. Every transition is a pure function that
 * returns a new run, so the extension can journal each result as a session
 * entry and tests can drive the stop gate without a session.
 */
import type {
	PauseReason,
	RefereeBudgets,
	RefereeRun,
	ReviewKind,
	ReviewOutcome,
	ReviewRecord,
	Verdict,
} from "./types";

/** Custom session entry type holding a run snapshot; the newest one on the branch wins. */
export const RUN_ENTRY_TYPE = "referee-run";

/** Reviews in a row the referee may fail to complete before the run pauses. */
export const MAX_REVIEW_ERRORS = 3;

export function createRun(input: { id: string; objective: string; refereeModel: string; now: number }): RefereeRun {
	const objective = input.objective.trim();
	if (!objective) throw new Error("The objective is empty.");
	return {
		id: input.id,
		objective,
		objectiveVersion: 1,
		status: "active",
		refereeModel: input.refereeModel,
		createdAt: input.now,
		updatedAt: input.now,
		reviews: [],
		reviewsSinceResume: 0,
		costSinceResume: 0,
		costUsd: 0,
		stopAllowed: false,
		idleStops: 0,
		reviewErrors: 0,
	};
}

/** A run that still owns the session: active, or paused and resumable. */
export function isLive(run: RefereeRun | undefined): run is RefereeRun {
	return run?.status === "active" || run?.status === "paused";
}

/**
 * Replace the objective. A new version voids verdicts on the old one, including
 * a pending escalation, so the agent has to earn a pass against the new text.
 *
 * @throws Error when the run is over or the objective is empty.
 */
export function editObjective(run: RefereeRun, objective: string, now: number): RefereeRun {
	if (!isLive(run)) throw new Error("The referee run is over; start a new one with /referee <objective>.");
	const text = objective.trim();
	if (!text) throw new Error("The objective is empty.");
	if (text === run.objective) return run;
	return {
		...run,
		objective: text,
		objectiveVersion: run.objectiveVersion + 1,
		stopAllowed: false,
		idleStops: 0,
		updatedAt: now,
	};
}

export function pauseRun(run: RefereeRun, reason: PauseReason, now: number): RefereeRun {
	if (run.status !== "active") return run;
	return { ...run, status: "paused", pauseReason: reason, stopAllowed: false, idleStops: 0, updatedAt: now };
}

/** Re-arm the gate. The review, spend, and error budgets start over. */
export function resumeRun(run: RefereeRun, now: number): RefereeRun {
	if (run.status !== "paused") return run;
	const { pauseReason: _reason, ...rest } = run;
	return {
		...rest,
		status: "active",
		reviewsSinceResume: 0,
		costSinceResume: 0,
		idleStops: 0,
		reviewErrors: 0,
		updatedAt: now,
	};
}

export function stopRun(run: RefereeRun, now: number): RefereeRun {
	if (!isLive(run)) return run;
	const { pauseReason: _reason, ...rest } = run;
	return { ...rest, status: "stopped", stopAllowed: false, updatedAt: now };
}

/** Switch the referee model; the next review starts a fresh referee session on it. */
export function setRefereeModel(run: RefereeRun, refereeModel: string, now: number): RefereeRun {
	if (run.refereeModel === refereeModel) return run;
	return { ...run, refereeModel, reviewErrors: 0, updatedAt: now };
}

/** Whether a review ended without running its course: cancelled, or cut short by an objective edit. */
export function wasCancelled(review: ReviewRecord): boolean {
	return review.outcome === "aborted" || (review.outcome === "stale" && review.verdict === undefined);
}

/**
 * Record a finished review and apply its verdict: `pass` ends the run,
 * `escalate` lets the next stop through, and `fail` leaves the gate armed. A
 * verdict on an older objective version is recorded as stale and applies
 * nothing. Cancelled reviews count toward neither the review budget nor the
 * error streak, and {@link MAX_REVIEW_ERRORS} errored reviews in a row pause an
 * active run.
 */
export function recordReview(run: RefereeRun, review: ReviewRecord, now: number): RefereeRun {
	const stale = review.outcome === "verdict" && review.objectiveVersion !== run.objectiveVersion;
	const entry: ReviewRecord = stale ? { ...review, outcome: "stale" } : review;
	const cancelled = wasCancelled(entry);
	const reviewErrors = entry.outcome === "error" ? run.reviewErrors + 1 : cancelled ? run.reviewErrors : 0;
	const next: RefereeRun = {
		...run,
		reviews: [...run.reviews, entry],
		reviewsSinceResume: run.reviewsSinceResume + (cancelled ? 0 : 1),
		costSinceResume: run.costSinceResume + entry.costUsd,
		costUsd: run.costUsd + entry.costUsd,
		reviewErrors,
		updatedAt: now,
	};
	if (!isLive(run)) return next;
	if (entry.outcome === "error") return reviewErrors >= MAX_REVIEW_ERRORS ? pauseRun(next, "error", now) : next;
	if (entry.outcome !== "verdict") return next;
	if (entry.verdict === "pass") {
		const { pauseReason: _reason, ...rest } = next;
		return { ...rest, status: "passed", stopAllowed: false, idleStops: 0 };
	}
	if (entry.verdict === "escalate" && run.status === "active") return { ...next, stopAllowed: true };
	return next;
}

/** Add referee spend that is not a review (status checks). */
export function addSpend(run: RefereeRun, costUsd: number, now: number): RefereeRun {
	if (costUsd <= 0) return run;
	return {
		...run,
		costUsd: run.costUsd + costUsd,
		costSinceResume: run.costSinceResume + costUsd,
		updatedAt: now,
	};
}

/** Why another review would exceed the budget, or undefined when it fits. */
export function budgetExhausted(run: RefereeRun, budgets: RefereeBudgets): string | undefined {
	if (budgets.maxReviews !== undefined && run.reviewsSinceResume >= budgets.maxReviews) {
		return `the review limit (${budgets.maxReviews}) is reached`;
	}
	if (budgets.maxCostUsd !== undefined && run.costSinceResume >= budgets.maxCostUsd) {
		return `the referee budget ($${budgets.maxCostUsd.toFixed(2)}) is spent`;
	}
	return undefined;
}

export type StopDecision =
	/** Let the stop through; `run` is the updated run when the stop consumed an escalation. */
	| { action: "allow"; run?: RefereeRun }
	/** Keep the agent working; `run` carries the updated stall count. */
	| { action: "block"; run: RefereeRun }
	/** The agent keeps stopping without doing anything: pause the run and let the stop through. */
	| { action: "stall"; run: RefereeRun };

/**
 * Decide one main-session stop. `usedTools` says whether the agent ran any tool
 * since the previous stop the gate saw; `stallLimit` tool-free stops in a row
 * pause the run instead of sending the agent back again.
 */
export function decideStop(
	run: RefereeRun | undefined,
	usedTools: boolean,
	stallLimit: number,
	now: number,
): StopDecision {
	if (run?.status !== "active") return { action: "allow" };
	if (run.stopAllowed) return { action: "allow", run: { ...run, stopAllowed: false, idleStops: 0, updatedAt: now } };
	const idleStops = usedTools ? 0 : run.idleStops + 1;
	if (idleStops >= stallLimit) return { action: "stall", run: pauseRun(run, "stalled", now) };
	return { action: "block", run: idleStops === run.idleStops ? run : { ...run, idleStops, updatedAt: now } };
}

/** The newest valid run snapshot among session entries (oldest first), if any. */
export function restoreRun(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): RefereeRun | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE) return parseRun(entry.data);
	}
	return undefined;
}

const RUN_STATUSES: Record<RefereeRun["status"], true> = { active: true, paused: true, passed: true, stopped: true };
const PAUSE_REASONS: Record<PauseReason, true> = {
	user: true,
	restored: true,
	stalled: true,
	budget: true,
	error: true,
};
const REVIEW_KINDS: Record<ReviewKind, true> = { complete: true, blocked: true };
const VERDICTS: Record<Verdict, true> = { pass: true, fail: true, escalate: true };
const OUTCOMES: Record<ReviewOutcome, true> = { verdict: true, stale: true, error: true, aborted: true };

/** Whether `value` is one of `table`'s keys (own keys only, so `constructor` and friends never match). */
function isKey<K extends string>(table: Record<K, true>, value: unknown): value is K {
	return typeof value === "string" && Object.hasOwn(table, value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validate a journaled run snapshot; undefined when it is malformed. */
export function parseRun(raw: unknown): RefereeRun | undefined {
	if (!isObject(raw)) return undefined;
	const {
		id,
		objective,
		objectiveVersion,
		status,
		pauseReason,
		refereeModel,
		createdAt,
		updatedAt,
		reviews,
		reviewsSinceResume,
		costSinceResume,
		costUsd,
		stopAllowed,
		idleStops,
		reviewErrors,
	} = raw;
	if (typeof id !== "string" || !id) return undefined;
	if (typeof objective !== "string" || !objective.trim()) return undefined;
	if (!isCount(objectiveVersion) || objectiveVersion < 1) return undefined;
	if (!isKey(RUN_STATUSES, status)) return undefined;
	if (pauseReason !== undefined && !isKey(PAUSE_REASONS, pauseReason)) return undefined;
	if (typeof refereeModel !== "string" || !refereeModel) return undefined;
	if (!isCount(createdAt) || !isCount(updatedAt)) return undefined;
	if (!Array.isArray(reviews)) return undefined;
	const parsedReviews: ReviewRecord[] = [];
	for (const review of reviews) {
		const parsed = parseReview(review);
		if (!parsed) return undefined;
		parsedReviews.push(parsed);
	}
	if (
		!isCount(reviewsSinceResume) ||
		!isCount(costSinceResume) ||
		!isCount(costUsd) ||
		!isCount(idleStops) ||
		!isCount(reviewErrors)
	) {
		return undefined;
	}
	if (typeof stopAllowed !== "boolean") return undefined;
	const run: RefereeRun = {
		id,
		objective,
		objectiveVersion,
		status,
		refereeModel,
		createdAt,
		updatedAt,
		reviews: parsedReviews,
		reviewsSinceResume,
		costSinceResume,
		costUsd,
		stopAllowed,
		idleStops,
		reviewErrors,
	};
	if (status === "paused") run.pauseReason = pauseReason ?? "user";
	return run;
}

function parseReview(raw: unknown): ReviewRecord | undefined {
	if (!isObject(raw)) return undefined;
	const {
		index,
		kind,
		outcome,
		verdict,
		summary,
		findings,
		objectiveVersion,
		startedAt,
		durationMs,
		tokens,
		costUsd,
	} = raw;
	if (!isCount(index) || index < 1) return undefined;
	if (!isKey(REVIEW_KINDS, kind)) return undefined;
	if (!isKey(OUTCOMES, outcome)) return undefined;
	if (verdict !== undefined && !isKey(VERDICTS, verdict)) return undefined;
	if (typeof summary !== "string") return undefined;
	if (!Array.isArray(findings) || !findings.every(finding => typeof finding === "string")) return undefined;
	if (!isCount(objectiveVersion) || !isCount(startedAt) || !isCount(durationMs)) return undefined;
	if (!isCount(tokens) || !isCount(costUsd)) return undefined;
	const review: ReviewRecord = {
		index,
		kind,
		outcome,
		summary,
		findings: findings as string[],
		objectiveVersion,
		startedAt,
		durationMs,
		tokens,
		costUsd,
	};
	if (verdict !== undefined) review.verdict = verdict;
	return review;
}
