/**
 * The panel above the editor for `/referee status` and `/referee show`: a
 * title, the referee's live step while it works, then a markdown answer. Like
 * `/btw`, it never enters the conversation.
 */
import { getMarkdownTheme, type Theme } from "@oh-my-pi/pi-coding-agent";
import { type Component, Container, Markdown, Text, type TUI } from "@oh-my-pi/pi-tui";
import { activityLabel, oneLine } from "./render";
import type { RefereeActivity } from "./types";

const TITLE_WIDTH = 120;

export class RefereePanel {
	readonly #theme: Theme;
	readonly #title: Text;
	readonly #status = new Text("", 1, 0);
	readonly #hint = new Text("", 1, 0);
	#body: Component | undefined;
	#activity: RefereeActivity | undefined;
	#settled = false;
	#frame = 0;
	#tui: TUI | undefined;

	constructor(title: string, theme: Theme) {
		this.#theme = theme;
		this.#title = new Text(`${theme.fg("accent", "⚖")} ${theme.bold(oneLine(title, TITLE_WIDTH))}`, 1, 0);
	}

	/** Factory for `ctx.ui.setWidget`. */
	readonly widget = (tui: TUI): Component => {
		this.#tui = tui;
		return new PanelComponent(() => this.#children());
	};

	get settled(): boolean {
		return this.#settled;
	}

	/** Advance the spinner while the referee works. */
	tick(): void {
		if (this.#settled) return;
		this.#frame += 1;
		this.#tui?.requestRender();
	}

	setActivity(activity: RefereeActivity): void {
		this.#activity = activity;
		this.#tui?.requestRender();
	}

	/** Show the answer; the panel stays until Esc. */
	finish(markdown: string): void {
		this.#settled = true;
		this.#body = new Markdown(markdown, 1, 0, getMarkdownTheme());
		this.#tui?.requestRender();
	}

	fail(message: string): void {
		this.#settled = true;
		this.#body = new Text(this.#theme.fg("error", message), 1, 0);
		this.#tui?.requestRender();
	}

	#children(): Component[] {
		if (this.#settled) {
			this.#hint.setText(this.#theme.fg("dim", "esc closes"));
			return this.#body ? [this.#title, this.#body, this.#hint] : [this.#title, this.#hint];
		}
		const frames = this.#theme.getSpinnerFrames("activity");
		const spinner = frames[this.#frame % frames.length] ?? "·";
		this.#status.setText(
			`${this.#theme.fg("accent", spinner)} ${this.#theme.fg("muted", this.#activity ? activityLabel(this.#activity) : "starting the referee")}`,
		);
		this.#hint.setText(this.#theme.fg("dim", "esc cancels"));
		return [this.#title, this.#status, this.#hint];
	}
}

/** Children rebuilt on every paint, so state changes need only a render request. */
class PanelComponent extends Container {
	constructor(readonly children_: () => readonly Component[]) {
		super();
	}

	override render(width: number): readonly string[] {
		this.clear();
		for (const child of this.children_()) this.addChild(child);
		return super.render(width);
	}
}
