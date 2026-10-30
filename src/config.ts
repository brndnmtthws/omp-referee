/** omp-referee configuration (`<agent dir>/referee.json`): the referee model, extra referee instructions, and budgets. */
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { formatModelString, resolveCliModel, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import type { RefereeBudgets } from "./types";

export interface RefereeConfig {
	/** Referee model selector (`provider/id`, role alias, optional `:thinking` suffix). */
	model?: string;
	/** Extra guidance appended to the referee's system prompt. */
	instructions?: string;
	/** Reviews per active stretch of a run; absent means unlimited. */
	maxReviews?: number;
	/** Referee spend per active stretch of a run, in USD; absent means unlimited. */
	maxCostUsd?: number;
	/** Consecutive tool-free stops before the run pauses; defaults to {@link DEFAULT_STALL_LIMIT}. */
	stallLimit?: number;
}

export const DEFAULT_STALL_LIMIT = 3;

export const BUDGET_KEYS = ["maxReviews", "maxCostUsd", "stallLimit"] as const;

export type BudgetKey = (typeof BUDGET_KEYS)[number];

/** `<agent dir>/referee.json`, shared by every project. */
export function refereeConfigPath(): string {
	return path.join(getAgentDir(), "referee.json");
}

/** The saved configuration; a missing file is an empty one. */
export async function readRefereeConfig(file = refereeConfigPath()): Promise<RefereeConfig> {
	let raw: unknown;
	try {
		raw = await Bun.file(file).json();
	} catch (error) {
		if (isEnoent(error)) return {};
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return normalizeRefereeConfig(raw, file);
}

export async function writeRefereeConfig(config: RefereeConfig, file = refereeConfigPath()): Promise<void> {
	await Bun.write(file, `${JSON.stringify(config, null, "\t")}\n`);
}

/**
 * Validate a parsed config; `label` prefixes error messages. A zero review or
 * spend budget means unlimited and is dropped.
 */
export function normalizeRefereeConfig(raw: unknown, label: string): RefereeConfig {
	if (!isRecord(raw)) throw new Error(`${label} must be a JSON object`);
	const config: RefereeConfig = {};
	const { model, instructions, maxReviews, maxCostUsd, stallLimit } = raw;
	if (model !== undefined) {
		if (typeof model !== "string" || !model.trim()) throw new Error(`${label}: "model" must be a non-empty string`);
		config.model = model.trim();
	}
	if (instructions !== undefined) {
		if (typeof instructions !== "string") throw new Error(`${label}: "instructions" must be a string`);
		if (instructions.trim()) config.instructions = instructions.trim();
	}
	if (maxReviews !== undefined) {
		if (!Number.isSafeInteger(maxReviews) || (maxReviews as number) < 0) {
			throw new Error(`${label}: "maxReviews" must be a non-negative integer`);
		}
		if ((maxReviews as number) > 0) config.maxReviews = maxReviews as number;
	}
	if (maxCostUsd !== undefined) {
		if (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
			throw new Error(`${label}: "maxCostUsd" must be a non-negative number`);
		}
		if (maxCostUsd > 0) config.maxCostUsd = maxCostUsd;
	}
	if (stallLimit !== undefined) {
		if (!Number.isSafeInteger(stallLimit) || (stallLimit as number) < 1) {
			throw new Error(`${label}: "stallLimit" must be a positive integer`);
		}
		config.stallLimit = stallLimit as number;
	}
	return config;
}

export function resolveBudgets(config: RefereeConfig): RefereeBudgets {
	const budgets: RefereeBudgets = { stallLimit: config.stallLimit ?? DEFAULT_STALL_LIMIT };
	if (config.maxReviews) budgets.maxReviews = config.maxReviews;
	if (config.maxCostUsd) budgets.maxCostUsd = config.maxCostUsd;
	return budgets;
}

export interface ResolvedRefereeModel {
	model: Model<Api>;
	thinking?: ConfiguredThinkingLevel;
	/** `provider/id`, plus `:thinking` when the selector set one. */
	selector: string;
}

/**
 * Resolve a referee model selector to a model with credentials.
 *
 * @throws Error with a user-facing message for an unknown model or missing credentials.
 */
export function resolveRefereeModel(
	selector: string,
	modelRegistry: ModelRegistry,
	settings: Settings,
): ResolvedRefereeModel {
	const result = resolveCliModel({ cliModel: selector, modelRegistry, settings });
	if (result.error || !result.model)
		throw new Error(`Referee model ${selector}: ${result.error ?? "model not found"}`);
	if (!modelRegistry.hasConfiguredAuth(result.model)) {
		throw new Error(
			`Referee model ${formatModelString(result.model)}: no credentials for provider ${result.model.provider}`,
		);
	}
	return toResolved(result.model, result.thinkingLevel);
}

/**
 * The referee model when the config names none: a configured
 * `modelRoles.advisor` as is; otherwise the first candidate of the `advisor`
 * role chain over `available` (the `slow` role, then its built-in chain) from a
 * different family than the main model, else the chain's first candidate.
 * Falls back to the main model itself.
 *
 * @throws Error when no model is available at all.
 */
export function defaultRefereeModel(
	settings: Settings,
	available: Model<Api>[],
	family: (model: Model<Api>) => string,
	main: Model<Api> | undefined,
): ResolvedRefereeModel {
	const candidates = resolveRoleChain("advisor", settings, available);
	const first = candidates[0];
	const pick =
		!first || !main || Object.hasOwn(settings.getModelRoles(), "advisor")
			? first
			: (candidates.find(candidate => family(candidate.model) !== family(main)) ?? first);
	if (pick) return toResolved(pick.model, pick.thinkingLevel);
	if (main) return toResolved(main, undefined);
	throw new Error("No model is available for the referee: run /login, or pick one with /referee model.");
}

function toResolved(model: Model<Api>, thinking: ConfiguredThinkingLevel | undefined): ResolvedRefereeModel {
	const base = formatModelString(model);
	return thinking === undefined ? { model, selector: base } : { model, thinking, selector: `${base}:${thinking}` };
}
