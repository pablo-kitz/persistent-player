import { App, MarkdownView, Plugin, setIcon, WorkspaceLeaf } from "obsidian";

// -- Types -------------------------------------------------------------------

type Evt = "play" | "pause" | "timeupdate" | "ratechange" | "change";
type Cb = () => void;

// -- Controller --------------------------------------------------------------
// Maintains a pool of <audio> elements, one per source note. Navigation only
// moves the controls; starting another embed changes the active audio.

class Controller {
	/** notePath -> audio element (keeps loaded state, position, etc.). */
	private pool = new Map<string, HTMLAudioElement>();
	private activeNote = "";
	private volume = 1;
	private rate = 1;
	private subs = new Map<Evt, Set<Cb>>();

	/** Get the audio element for a note. */
	private getEl(note: string): HTMLAudioElement | null {
		return this.pool.get(note) ?? null;
	}

	/** The currently active audio element. */
	get active(): HTMLAudioElement | null {
		return this.getEl(this.activeNote);
	}

	get hasActive(): boolean { return this.active !== null; }
	get notePath(): string { return this.activeNote; }
	get playing(): boolean { return this.active ? !this.active.paused && !this.active.ended : false; }
	get currentTime(): number { return this.active?.currentTime ?? 0; }
	get playbackRate(): number { return this.rate; }

	duration(): number { return this.active?.duration ?? 0; }

	/** Start playing a new src in a note. Creates or reuses an audio element. */
	loadAndPlay(src: string, note: string) {
		this.active?.pause();

		let el = this.pool.get(note);
		if (!el) {
			el = document.body.createEl("audio", { cls: "pp-pooled" });
			this.pool.set(note, el);
			this.wireEvents(el);
		}

		if (el.src !== src) el.src = src;
		el.volume = this.volume;
		el.playbackRate = this.rate;
		this.activeNote = note;
		this.emit("change");
		void el.play();
	}

	play() { void this.active?.play(); }
	pause() { this.active?.pause(); }
	toggle() { if (this.playing) this.pause(); else this.play(); }
	seek(t: number) { if (this.active) this.active.currentTime = t; }

	/** Jump relative to the current position, clamped to [0, duration]. */
	seekBy(delta: number) {
		const el = this.active;
		if (!el) return;
		const d = this.duration();
		let t = el.currentTime + delta;
		if (t < 0) t = 0;
		if (d && t > d) t = d;
		el.currentTime = t;
		this.emit("timeupdate");
	}

	setRate(r: number) {
		this.rate = r;
		if (this.active) this.active.playbackRate = r;
		this.emit("ratechange");
	}

	/** Remove a note's audio from the pool (close button). */
	clearNote(note: string) {
		const el = this.pool.get(note);
		if (el) { el.pause(); el.remove(); this.pool.delete(note); }
		if (this.activeNote === note) this.activeNote = "";
		this.emit("change");
	}

	private wireEvents(el: HTMLAudioElement) {
		el.addEventListener("play", () => { if (el === this.active) this.emit("play"); });
		el.addEventListener("pause", () => { if (el === this.active) this.emit("pause"); });
		el.addEventListener("timeupdate", () => { if (el === this.active) this.emit("timeupdate"); });
		el.addEventListener("loadedmetadata", () => { if (el === this.active) this.emit("timeupdate"); });
		el.addEventListener("ended", () => {
			if (el === this.active) {
				el.currentTime = 0;
				this.emit("pause");
			}
		});
		el.addEventListener("ratechange", () => { if (el === this.active) this.emit("ratechange"); });
	}

	on(ev: Evt, cb: Cb) {
		let set = this.subs.get(ev);
		if (!set) { set = new Set(); this.subs.set(ev, set); }
		set.add(cb);
	}

	private emit(ev: Evt) {
		this.subs.get(ev)?.forEach(cb => cb());
	}

	destroy() {
		for (const el of this.pool.values()) { el.pause(); el.remove(); }
		this.pool.clear();
		this.subs.clear();
	}
}

// -- Now Playing Bar ---------------------------------------------------------

class NowPlayingBar {
	private bar: HTMLElement | null = null;
	private playBtn: HTMLElement | null = null;
	private track: HTMLElement | null = null;
	private fill: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private rateEl: HTMLElement | null = null;
	private sourceEl: HTMLElement | null = null;
	private dragging = false;

	constructor(private ctrl: Controller, private app: App, plugin: Plugin) {
		ctrl.on("play", () => { this.show(); this.syncIcon(); });
		ctrl.on("change", () => { this.show(); this.syncSource(); this.syncIcon(); this.syncProgress(); });
		ctrl.on("pause", () => this.syncIcon());
		ctrl.on("timeupdate", () => this.syncProgress());
		ctrl.on("ratechange", () => { if (this.rateEl) this.rateEl.textContent = `${this.ctrl.playbackRate}x`; });

		plugin.registerDomEvent(document, "mousemove", (e) => { if (this.dragging) this.seekTo(e.clientX); });
		plugin.registerDomEvent(document, "mouseup", () => { this.dragging = false; });
	}

	show() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const vc = view?.containerEl.querySelector(".view-content");
		if (!this.ctrl.hasActive || !vc) { this.hide(); return; }
		if (this.bar?.parentElement === vc) { this.syncSource(); return; }

		this.hide();
		const bar = (this.bar = createDiv("pp-now-playing"));
		this.mkSkip(bar, "-5s", "Skip back 5 seconds", -5);
		const play = (this.playBtn = bar.createDiv("clickable-icon pp-np-play"));
		setIcon(play, this.ctrl.playing ? "pause" : "play");
		play.setAttribute("aria-label", "Play or pause");
		play.setAttribute("title", "Play or pause");
		play.addEventListener("click", () => this.ctrl.toggle());
		this.mkSkip(bar, "+5s", "Skip forward 5 seconds", 5);

		const center = bar.createDiv("pp-np-center");
		this.track = center.createDiv("pp-np-track");
		this.fill = this.track.createDiv("pp-np-fill");
		this.syncProgress();
		center.addEventListener("mousedown", (e) => { this.dragging = true; this.seekTo(e.clientX); });

		const right = bar.createDiv("pp-np-right");
		this.timeEl = right.createSpan({ cls: "pp-np-time" });
		this.syncProgress();
		this.rateEl = right.createDiv("clickable-icon pp-np-rate");
		this.rateEl.textContent = `${this.ctrl.playbackRate}x`;
		this.rateEl.setAttribute("aria-label", "Playback speed");
		this.rateEl.setAttribute("title", "Playback speed");
		this.rateEl.addEventListener("click", () => this.cycleRate());
		this.sourceEl = right.createEl("button", { cls: "pp-np-source" });
		this.sourceEl.setAttribute("type", "button");
		this.syncSource();
		this.sourceEl.addEventListener("click", () => {
			if (this.ctrl.notePath) void this.app.workspace.openLinkText(this.ctrl.notePath, "");
		});
		const close = right.createDiv("clickable-icon pp-np-close");
		setIcon(close, "x");
		close.setAttribute("aria-label", "Close player");
		close.setAttribute("title", "Close player");
		close.addEventListener("click", () => {
			this.ctrl.clearNote(this.ctrl.notePath);
			this.hide();
		});

		vc.insertBefore(bar, vc.firstChild);
	}

	hide() {
		this.bar?.remove();
		this.bar = this.playBtn = this.track = this.fill = this.timeEl = this.rateEl = this.sourceEl = null;
		this.dragging = false;
	}

	private syncSource() {
		if (!this.sourceEl) return;
		const path = this.ctrl.notePath;
		this.sourceEl.hidden = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path === path;
		this.sourceEl.textContent = path.split("/").pop()?.replace(/\.md$/, "") || "Audio";
		this.sourceEl.setAttribute("title", path ? `Open source note: ${path}` : "Audio");
		this.sourceEl.setAttribute("aria-label", path ? `Open source note: ${path}` : "Audio");
	}

	private mkSkip(parent: HTMLElement, label: string, title: string, delta: number) {
		const btn = parent.createDiv("clickable-icon pp-np-skip");
		btn.textContent = label;
		btn.setAttribute("aria-label", title);
		btn.setAttribute("title", title);
		btn.addEventListener("click", () => this.ctrl.seekBy(delta));
	}

	private syncIcon() {
		if (this.playBtn) setIcon(this.playBtn, this.ctrl.playing ? "pause" : "play");
	}

	private syncProgress() {
		const d = this.ctrl.duration();
		const t = this.ctrl.currentTime;
		if (d && this.fill && !this.dragging) this.fill.style.width = `${(t / d) * 100}%`;
		if (this.timeEl) this.timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
	}

	private seekTo(clientX: number) {
		if (!this.track) return;
		const r = this.track.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
		if (this.fill) this.fill.style.width = `${ratio * 100}%`;
		const d = this.ctrl.duration();
		if (d) this.ctrl.seek(ratio * d);
	}

	private cycleRate() {
		const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
		const i = rates.indexOf(this.ctrl.playbackRate);
		const next = rates[(i + 1) % rates.length] ?? 1;
		this.ctrl.setRate(next);
	}

	destroy() { this.hide(); }
}

// -- Playing Tab Indicator ---------------------------------------------------

class PlayingTabIndicator {
	private badges = new Set<HTMLElement>();

	constructor(private ctrl: Controller, private app: App) {
		for (const event of ["play", "pause", "change"] as const) {
			ctrl.on(event, () => this.sync());
		}
	}

	sync() {
		this.destroy();
		if (!this.ctrl.playing || !this.ctrl.notePath) return;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== this.ctrl.notePath) continue;
			// Obsidian has no public tab-badge API. Keep this optional internal
			// access isolated, and skip surfaces (such as mobile) without a header.
			const header = (leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement }).tabHeaderEl;
			if (!header) continue;
			const inner = header.querySelector(".workspace-tab-header-inner") ?? header;
			const badge = inner.createSpan({ cls: "pp-tab-playing" });
			const close = inner.querySelector(".workspace-tab-header-inner-close-button");
			if (close?.parentElement === inner) inner.insertBefore(badge, close);
			badge.setAttribute("role", "img");
			badge.setAttribute("aria-label", "Playing audio from this note");
			badge.setAttribute("title", "Playing audio from this note");
			setIcon(badge, "volume-2");
			this.badges.add(badge);
		}
	}

	destroy() {
		for (const badge of this.badges) badge.remove();
		this.badges.clear();
	}
}

// -- Plugin ------------------------------------------------------------------

export default class PersistentPlayerPlugin extends Plugin {
	private ctrl!: Controller;
	private bar!: NowPlayingBar;
	private tabs!: PlayingTabIndicator;

	onload() {
		this.ctrl = new Controller();
		this.bar = new NowPlayingBar(this.ctrl, this.app, this);
		this.tabs = new PlayingTabIndicator(this.ctrl, this.app);

		this.registerDomEvent(document, "play", (e: Event) => {
			const t = e.target;
			// Only hijack audio embeds. Video keeps its native inline player:
			// the now-playing bar has no video surface, so pooling a video
			// would silently drop the picture.
			if (!(t instanceof HTMLAudioElement)) return;
			if (t.hasClass("pp-pooled")) return;
			if (!t.closest(".workspace")) return;
			const src = t.src;
			if (!src) return;

			// Neutralise the inline embed so only the pooled element plays.
			t.removeAttribute("src");
			t.load();

			// In split panes, the clicked embed need not belong to the active view.
			const source = this.app.workspace.getLeavesOfType("markdown")
				.find(leaf => leaf.view.containerEl.contains(t));
			const note = source?.view instanceof MarkdownView ? source.view.file?.path ?? "" : "";
			this.ctrl.loadAndPlay(src, note);
		}, true);

		const syncWorkspace = () => { this.bar.show(); this.tabs.sync(); };
		this.registerEvent(this.app.workspace.on("active-leaf-change", syncWorkspace));
		this.registerEvent(this.app.workspace.on("file-open", syncWorkspace));
		this.registerEvent(this.app.workspace.on("layout-change", syncWorkspace));

		this.addCommand({
			id: "toggle-playback",
			name: "Play or pause",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.toggle();
				return true;
			},
		});
		this.addCommand({
			id: "skip-back-5",
			name: "Skip back 5 seconds",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.seekBy(-5);
				return true;
			},
		});
		this.addCommand({
			id: "skip-forward-5",
			name: "Skip forward 5 seconds",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.seekBy(5);
				return true;
			},
		});
		this.addCommand({
			id: "skip-back-15",
			name: "Skip back 15 seconds",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.seekBy(-15);
				return true;
			},
		});
		this.addCommand({
			id: "skip-forward-15",
			name: "Skip forward 15 seconds",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.seekBy(15);
				return true;
			},
		});
	}

	onunload() {
		this.ctrl?.destroy();
		this.bar?.destroy();
		this.tabs?.destroy();
	}
}

function fmt(sec: number): string {
	if (!sec || !isFinite(sec)) return "0:00";
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}
