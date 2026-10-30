import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import {
	defaultRefereeModel,
	normalizeRefereeConfig,
	readRefereeConfig,
	resolveBudgets,
	writeRefereeConfig,
} from "../src/config";

describe("referee config", () => {
	let root: string;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-referee-config-"));
	});

	afterAll(async () => {
		await removeWithRetries(root);
	});

	it("reads a missing file as an empty config and round-trips a saved one", async () => {
		const file = path.join(root, "referee.json");
		expect(await readRefereeConfig(file)).toEqual({});
		await writeRefereeConfig({ model: "openai/gpt-5.2:high", maxReviews: 5, stallLimit: 2 }, file);
		expect(await readRefereeConfig(file)).toEqual({ model: "openai/gpt-5.2:high", maxReviews: 5, stallLimit: 2 });
	});

	it("reports unreadable JSON with the file path", async () => {
		const file = path.join(root, "broken.json");
		await Bun.write(file, "{ not json");
		await expect(readRefereeConfig(file)).rejects.toThrow(file);
	});

	it("treats zero budgets as unlimited and defaults the stall limit", () => {
		const config = normalizeRefereeConfig({ maxReviews: 0, maxCostUsd: 0, instructions: "  " }, "cfg");
		expect(config).toEqual({});
		expect(resolveBudgets(config)).toEqual({ stallLimit: 3 });
		expect(resolveBudgets({ maxReviews: 4, maxCostUsd: 1.5, stallLimit: 5 })).toEqual({
			maxReviews: 4,
			maxCostUsd: 1.5,
			stallLimit: 5,
		});
	});

	it("rejects invalid values with the offending key", () => {
		expect(() => normalizeRefereeConfig([], "cfg")).toThrow("cfg must be a JSON object");
		expect(() => normalizeRefereeConfig({ model: " " }, "cfg")).toThrow('"model"');
		expect(() => normalizeRefereeConfig({ maxReviews: 1.5 }, "cfg")).toThrow('"maxReviews"');
		expect(() => normalizeRefereeConfig({ maxCostUsd: -1 }, "cfg")).toThrow('"maxCostUsd"');
		expect(() => normalizeRefereeConfig({ stallLimit: 0 }, "cfg")).toThrow('"stallLimit"');
	});
});

describe("default referee model", () => {
	// A hermetic pool in two lineages, alpha-* and beta-*; real catalog models never enter it.
	const pool = ["alpha-main", "alpha-review", "beta-review"].map(
		id =>
			buildModel({
				id,
				name: id,
				api: "openai-completions",
				provider: "lab",
				baseUrl: "http://127.0.0.1:9/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64_000,
				maxTokens: 2048,
			} as ModelSpec<Api>) as Model<Api>,
	);
	const main = pool[0]!;
	const family = (model: Model<Api>) => model.id.split("-")[0]!;

	it("prefers the first advisor-chain candidate from another family than the main model", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": { advisor: ["lab/alpha-review", "lab/beta-review"] },
		});
		expect(defaultRefereeModel(settings, pool, family, main).selector).toBe("lab/beta-review");
	});

	it("uses a configured advisor role as is, even from the main model's family", () => {
		const settings = Settings.isolated({
			modelRoles: { advisor: "lab/alpha-review:high" },
			"retry.fallbackChains": { advisor: ["lab/beta-review"] },
		});
		expect(defaultRefereeModel(settings, pool, family, main).selector).toBe("lab/alpha-review:high");
	});

	it("falls back to the main model when the advisor chain resolves nothing", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { advisor: [] } });
		expect(defaultRefereeModel(settings, pool, family, main).selector).toBe("lab/alpha-main");
	});
});
