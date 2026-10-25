import { App, MarkdownView, Menu, Modal, Platform, Plugin, setIcon, WorkspaceLeaf, ItemView, TFile } from "obsidian";

// -- Types -------------------------------------------------------------------

type Evt = "play" | "pause" | "timeupdate" | "ratechange" | "change" | "metadata";
type Cb = () => void;

// -- Controller --------------------------------------------------------------
// Maintains a pool of <audio> elements, one per source note. Navigation only
// moves the controls; starting another embed changes the active audio.

class Controller {
	/** notePath -> audio element (keeps loaded state, position, etc.). */
	private pool = new Map<string, HTMLAudioElement>();
	private activeNote = "";
	private playlists = new Map<string, string[]>();
	metadata: MediaMetadataInit = {};
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
	loadAndPlay(src: string, note: string, sources?: string[]) {
		if (sources) {
			const unique = new Map<string, string>();
			for (const source of sources) {
				const key = audioSourceKey(source);
				if (!unique.has(key)) unique.set(key, source);
			}
			this.playlists.set(note, [...unique.values()]);
		}
		this.metadata = {};
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

	get tracks(): string[] { return this.playlists.get(this.activeNote) ?? []; }
	get trackIndex(): number { return this.tracks.findIndex(src => audioSourceKey(src) === audioSourceKey(this.active?.src ?? "")); }
	canSkipTrack(delta: number): boolean {
		const index = this.trackIndex + delta;
		return this.trackIndex >= 0 && index >= 0 && index < this.tracks.length;
	}
	skipTrack(delta: number) {
		if (this.canSkipTrack(delta)) this.loadAndPlay(this.tracks[this.trackIndex + delta], this.activeNote);
	}
	setMetadata(metadata: MediaMetadataInit) { this.metadata = metadata; this.emit("metadata"); }
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
	private mobileActions: HTMLElement[] = [];
	private panel: Modal | null = null;
	private art: HTMLElement | null = null;
	private previous: HTMLButtonElement | null = null;
	private next: HTMLButtonElement | null = null;
	private identity: HTMLElement | null = null;

	constructor(private ctrl: Controller, private app: App, plugin: Plugin) {
		ctrl.on("play", () => { this.show(); this.syncIcon(); });
		ctrl.on("change", () => { this.show(); this.syncSource(); this.syncIcon(); this.syncProgress(); this.syncIdentity(); });
		ctrl.on("metadata", () => { this.syncArtwork(); this.syncIdentity(); });
		ctrl.on("pause", () => this.syncIcon());
		ctrl.on("timeupdate", () => this.syncProgress());
		ctrl.on("ratechange", () => { if (this.rateEl) this.rateEl.textContent = `${this.ctrl.playbackRate}x`; });

		plugin.registerDomEvent(document, "pointermove", (e) => { if (this.dragging) this.seekTo(e.clientX); });
		plugin.registerDomEvent(document, "pointerup", () => { this.dragging = false; });
	}

	openPlayer() {
		if (Platform.isMobile && !this.panel && this.ctrl.hasActive) {
			const panel = new Modal(this.app);
			this.panel = panel;
			panel.modalEl.classList.add("pp-player-modal");
			panel.onClose = () => { this.panel = null; this.show(); };
			panel.open();
		}
		this.show();
		this.playBtn?.focus();
	}

	private mainView(): ItemView | null {
		// Restrict recency to the central workspace; sidebar focus must not
		// relocate the player or change whether its source-note link is shown.
		const view = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
		return view instanceof ItemView ? view : null;
	}

	show() {
		const view = this.mainView();
		if (Platform.isMobile && !this.panel) {
			this.hide();
			if (view && this.ctrl.hasActive) {
				this.mobileActions = [view.addAction("music", "Open player", () => this.openPlayer())];
			}
			return;
		}
		const vc = this.panel?.contentEl ?? view?.containerEl.querySelector(".view-content");
		if (!this.ctrl.hasActive || !vc) { this.hide(); return; }
		if (this.bar?.parentElement === vc) { this.syncSource(); this.syncTracks(); this.syncArtwork(); this.syncIdentity(); return; }

		this.hide();
		const bar = (this.bar = createDiv("pp-now-playing"));
		if (this.panel) {
			bar.classList.add("pp-player-card");
			this.art = bar.createDiv("pp-album-art");
			this.syncArtwork();
		}
		this.previous = this.mkTrackButton(bar, "skip-back", "Previous audio", -1);
		if (Platform.isMobile) this.mkSkip(bar, "-5s", "Skip back 5 seconds", -5);
		const play = (this.playBtn = bar.createDiv("clickable-icon pp-np-play"));
		setIcon(play, this.ctrl.playing ? "pause" : "play");
		play.setAttribute("aria-label", "Play or pause");
		play.setAttribute("tabindex", "0");
		play.setAttribute("title", "Play or pause");
		play.addEventListener("click", () => this.ctrl.toggle());
		if (Platform.isMobile) this.mkSkip(bar, "+5s", "Skip forward 5 seconds", 5);
		this.next = this.mkTrackButton(bar, "skip-forward", "Next audio", 1);
		this.syncTracks();
		this.identity = bar.createDiv("pp-np-identity");
		this.syncIdentity();

		const center = bar.createDiv("pp-np-center");
		this.track = center.createDiv("pp-np-track");
		this.fill = this.track.createDiv("pp-np-fill");
		this.syncProgress();
		center.addEventListener("pointerdown", (e) => { this.dragging = true; this.seekTo(e.clientX); });

		const right = bar.createDiv("pp-np-right");
		this.timeEl = right.createSpan({ cls: "pp-np-time" });
		this.syncProgress();
		if (!Platform.isMobile) this.mkSkip(right, "-5s", "Skip back 5 seconds", -5);
		this.rateEl = right.createEl("button", { cls: "clickable-icon pp-np-rate" });
		this.rateEl.textContent = `${this.ctrl.playbackRate}x`;
		this.rateEl.setAttribute("aria-label", "Playback speed");
		this.rateEl.setAttribute("title", "Playback speed");
		this.rateEl.setAttribute("aria-haspopup", "menu");
		this.rateEl.addEventListener("click", () => this.openRateMenu());
		if (!Platform.isMobile) this.mkSkip(right, "+5s", "Skip forward 5 seconds", 5);
		this.sourceEl = right.createEl("button", { cls: "clickable-icon pp-np-source" });
		this.sourceEl.setAttribute("type", "button");
		this.syncSource();
		this.sourceEl.addEventListener("click", () => {
			if (this.ctrl.notePath) void this.app.workspace.openLinkText(this.ctrl.notePath, "");
		});
		const close = right.createDiv("clickable-icon pp-np-close");
		setIcon(close, Platform.isMobile ? "square" : "x");
		if (Platform.isMobile) close.createSpan({ text: "Stop" });
		const closeLabel = Platform.isMobile ? "Stop playback" : "Close player";
		close.setAttribute("aria-label", closeLabel);
		close.setAttribute("title", closeLabel);
		close.addEventListener("click", () => {
			this.ctrl.clearNote(this.ctrl.notePath);
			this.panel?.close();
			this.hide();
		});

		vc.insertBefore(bar, vc.firstChild);
	}

	hide() {
		this.mobileActions.forEach(el => el.remove());
		this.mobileActions = [];
		this.bar?.remove();
		this.bar = this.playBtn = this.track = this.fill = this.timeEl = this.rateEl = this.sourceEl = null;
		this.dragging = false;
		this.art = this.previous = this.next = this.identity = null;
	}

	private mkTrackButton(parent: HTMLElement, icon: string, title: string, delta: number) {
		const button = parent.createEl("button", { cls: `clickable-icon pp-np-track-button ${delta < 0 ? "pp-np-previous" : "pp-np-next"}` });
		button.setAttribute("aria-label", title);
		button.setAttribute("title", title);
		setIcon(button, icon);
		button.addEventListener("click", () => this.ctrl.skipTrack(delta));
		return button;
	}

	private syncTracks() {
		for (const [button, delta] of [[this.previous, -1], [this.next, 1]] as const) {
			if (!button) continue;
			button.hidden = Platform.isMobile && this.ctrl.tracks.length < 2;
			button.disabled = !this.ctrl.canSkipTrack(delta);
		}
	}

	private syncArtwork() {
		if (!this.art) return;
		this.art.replaceChildren();
		const artwork = this.ctrl.metadata.artwork?.[0];
		if (artwork) {
			const image = this.art.createEl("img");
			image.src = artwork.src;
			image.alt = this.ctrl.metadata.album || "Album artwork";
		} else setIcon(this.art, "music");
	}

	private syncIdentity() {
		if (!this.identity) return;
		this.identity.replaceChildren();
		const metadata = this.ctrl.metadata;
		const filename = audioFilename(this.ctrl.active?.src ?? "");
		const label = this.identity.createSpan({ cls: "pp-np-title" });
		label.textContent = metadata.title || filename;
		label.setAttribute("title", filename);
		if (Platform.isMobile) {
			for (const value of [metadata.artist, metadata.album]) {
				if (value) this.identity.createDiv({ cls: "pp-track-detail", text: value });
			}
			return;
		}
		if (!metadata.title && !metadata.artist && !metadata.album) return;
		label.setAttribute("tabindex", "0");
		label.setAttribute("aria-label", `${metadata.title || filename}. Recording details`);
		const card = this.identity.createDiv("pp-track-card");
		const art = card.createDiv("pp-album-art");
		const artwork = metadata.artwork?.[0];
		if (artwork) {
			const image = art.createEl("img"); image.src = artwork.src;
			image.alt = metadata.album || "Album artwork";
		} else setIcon(art, "music");
		card.createDiv({ cls: "pp-track-title", text: metadata.title || filename });
		for (const value of [metadata.artist, metadata.album]) {
			if (value) card.createDiv({ cls: "pp-track-detail", text: value });
		}
	}

	private syncSource() {
		if (!this.sourceEl) return;
		const path = this.ctrl.notePath;
		const view = this.mainView();
		this.sourceEl.hidden = view instanceof MarkdownView && view.file?.path === path;
		setIcon(this.sourceEl, "external-link");
		this.sourceEl.setAttribute("title", path ? `Open source note: ${path}` : "Audio");
		this.sourceEl.setAttribute("aria-label", path ? `Open source note: ${path}` : "Audio");
	}

	private mkSkip(parent: HTMLElement, label: string, title: string, delta: number) {
		const btn = parent.createDiv(`clickable-icon pp-np-skip ${delta < 0 ? "pp-np-back" : "pp-np-forward"}`);
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
		if (this.fill && !this.dragging) this.fill.style.width = `${d > 0 && Number.isFinite(d) ? (t / d) * 100 : 0}%`;
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

	private openRateMenu() {
		if (!this.rateEl) return;
		const menu = new Menu();
		for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
			menu.addItem(item => item.setTitle(`${rate}×`)
				.setChecked(this.ctrl.playbackRate === rate)
				.onClick(() => this.ctrl.setRate(rate)));
		}
		const bounds = this.rateEl.getBoundingClientRect();
		menu.showAtPosition({ x: bounds.left, y: bounds.bottom + 4 });
	}

	destroy() { const panel = this.panel; if (panel) { panel.onClose = () => {}; panel.close(); } this.panel = null; this.hide(); }
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

// Shows ownership beside native embeds without touching their controls.
class EmbedPlaybackIndicator {
	private indicators = new Map<HTMLAudioElement, { row: HTMLElement; label: HTMLElement }>();
	private observer: MutationObserver;
	private destroyed = false;

	constructor(private ctrl: Controller, private app: App, private bar: NowPlayingBar, plugin: Plugin) {
		for (const event of ["play", "pause", "change"] as const) ctrl.on(event, () => this.sync());
		this.observer = new MutationObserver(() => this.sync());
		this.observer.observe(document.body, { childList: true, subtree: true });
		plugin.register(() => this.destroy());
	}

	sync() {
		if (this.destroyed) return;
		const matches = new Set<HTMLAudioElement>();
		if (this.ctrl.active) {
			const source = audioSourceKey(this.ctrl.active.src);
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== this.ctrl.notePath) continue;
				for (const audio of leaf.view.containerEl.querySelectorAll("audio")) {
					if (!audio.hasClass("pp-pooled") && audioSourceKey(audio.src || audio.currentSrc) === source) matches.add(audio);
				}
			}
		}
		for (const [audio, indicator] of this.indicators) {
			if (!matches.has(audio) || indicator.row.parentElement !== audio.parentElement) {
				indicator.row.remove();
				this.indicators.delete(audio);
			}
		}
		for (const audio of matches) {
			let indicator = this.indicators.get(audio);
			if (!indicator && audio.parentElement) {
				const row = createDiv("pp-embed-status");
				row.createSpan({ cls: "pp-embed-dot" });
				const label = row.createSpan({ cls: "pp-embed-label" });
				label.setAttribute("role", "status");
				const open = row.createEl("button", { text: "Open player", cls: "pp-embed-open" });
				open.setAttribute("type", "button");
				const icon = open.createSpan({ cls: "pp-embed-open-icon" });
				setIcon(icon, "arrow-up-right");
				open.addEventListener("click", () => this.bar.openPlayer());
				audio.parentElement.insertBefore(row, audio.nextSibling);
				indicator = { row, label };
				this.indicators.set(audio, indicator);
			}
			if (indicator) {
				const state = this.ctrl.playing ? "Playing" : "Paused";
				const text = `${state} in Persistent Player`;
				if (indicator.label.textContent !== text) indicator.label.textContent = text;
				indicator.row.setAttribute("data-state", state.toLowerCase());
			}
		}
	}

	destroy() {
		this.destroyed = true;
		this.observer.disconnect();
		for (const indicator of this.indicators.values()) indicator.row.remove();
		this.indicators.clear();
	}
}

// -- Plugin ------------------------------------------------------------------

export default class PersistentPlayerPlugin extends Plugin {
	private ctrl!: Controller;
	private bar!: NowPlayingBar;
	private tabs!: PlayingTabIndicator;
	private media!: SystemMedia;
	private embeds!: EmbedPlaybackIndicator;

	onload() {
		this.ctrl = new Controller();
		this.media = new SystemMedia(this.ctrl, this.app);
		this.bar = new NowPlayingBar(this.ctrl, this.app, this);
		this.tabs = new PlayingTabIndicator(this.ctrl, this.app);
		this.embeds = new EmbedPlaybackIndicator(this.ctrl, this.app, this.bar, this);

		this.registerDomEvent(document, "play", (e: Event) => {
			const t = e.target;
			// Only hijack audio embeds. Video keeps its native inline player:
			// the now-playing bar has no video surface, so pooling a video
			// would silently drop the picture.
			if (!(t instanceof HTMLAudioElement)) return;
			if (t.hasClass("pp-pooled")) return;
			if (!t.closest(".workspace")) return;
			const src = t.src || t.currentSrc;
			if (!src) return;

			// Pause the inline embed, preserving its source for track navigation.
			t.pause();

			// In split panes, the clicked embed need not belong to the active view.
			const source = this.app.workspace.getLeavesOfType("markdown")
				.find(leaf => leaf.view.containerEl.contains(t));
			const note = source?.view instanceof MarkdownView ? source.view.file?.path ?? "" : "";
			const view = source?.view;
			const cache = view instanceof MarkdownView && view.file
				? this.app.metadataCache?.getFileCache(view.file) : null;
			// Prefer actual note embeds: plugins and reading/editing surfaces can
			// render additional audio elements for the same note.
			const sources = cache?.embeds ? cache.embeds.flatMap(embed => {
				const file = this.app.metadataCache.getFirstLinkpathDest(embed.link.split("#")[0], note);
				return file && /^(mp3|wav|m4a|ogg|oga|flac|aac|aiff?|opus|webm|3gp)$/i.test(file.extension)
					? [this.app.vault.getResourcePath(file)] : [];
			}) : source ? Array.from(source.view.containerEl.querySelectorAll("audio"))
				.map(audio => audio.src || audio.currentSrc).filter(Boolean) : [];
			if (!sources.some(candidate => audioSourceKey(candidate) === audioSourceKey(src))) sources.push(src);
			this.ctrl.loadAndPlay(src, note, sources);
		}, true);

		const syncWorkspace = () => { this.bar.show(); this.tabs.sync(); this.embeds.sync(); };
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
		this.embeds?.destroy();
		this.media?.destroy();
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

// Metadata always follows the playing source, never the currently viewed note.
class SystemMedia {
 private revision = 0;
 private session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
 private actions: MediaSessionAction[] = [];
 constructor(private ctrl: Controller, private app: App) {
  const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
   play: () => ctrl.play(), pause: () => ctrl.pause(),
   previoustrack: () => ctrl.skipTrack(-1), nexttrack: () => ctrl.skipTrack(1),
   seekbackward: d => ctrl.seekBy(-(d.seekOffset ?? 5)),
   seekforward: d => ctrl.seekBy(d.seekOffset ?? 5),
   seekto: d => { if (d.seekTime !== undefined) ctrl.seek(d.seekTime); },
   stop: () => ctrl.clearNote(ctrl.notePath),
  };
  for (const action of Object.keys(handlers) as MediaSessionAction[]) {
   try { this.session?.setActionHandler(action, handlers[action]!); this.actions.push(action); } catch { /* Unsupported host action. */ }
  }
  ctrl.on("change", () => { void this.metadata(); });
  for (const event of ["play", "pause", "timeupdate", "ratechange"] as const) ctrl.on(event, () => this.sync());
 }
 private sync() {
  if (!this.session) return;
  this.session.playbackState = this.ctrl.hasActive ? (this.ctrl.playing ? "playing" : "paused") : "none";
  const duration = this.ctrl.duration();
  try {
   if (Number.isFinite(duration) && duration > 0) this.session.setPositionState({duration, playbackRate: this.ctrl.playbackRate, position: Math.max(0, Math.min(duration, this.ctrl.currentTime))});
   else this.session.setPositionState();
  } catch { /* Older embedded browsers may not support position state. */ }
 }
 private async metadata() {
  const revision = ++this.revision;
  if (!this.app.vault) return;
  if (this.session) this.session.metadata = null;
  this.sync();
  if (!this.ctrl.active) return;
  const file = this.app.vault.getAbstractFileByPath(this.ctrl.notePath);
  const props = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
  const text = (key: string) => typeof props?.[key] === "string" ? props[key] : "";
  const metadata: MediaMetadataInit = {title: text("title"), artist: text("artist"), album: text("album")};
  if (this.session) this.session.metadata = new MediaMetadata({...metadata, title: metadata.title || audioFilename(this.ctrl.active?.src ?? "")});
  this.ctrl.setMetadata(metadata);
  try {
   const { parseBlob } = await import("music-metadata");
   const src = this.ctrl.active.src;
   // WKWebView resource URLs are not reliably fetchable on iOS. Use the
   // public vault API for local audio, retaining fetch for remote embeds.
   const resourceKey = (url: string) => url.split("?")[0];
   const audioFile = this.app.vault.getFiles().find(candidate =>
    resourceKey(this.app.vault.getResourcePath(candidate)) === resourceKey(src));
   let blob: Blob;
   if (audioFile) blob = new Blob([await this.app.vault.readBinary(audioFile)]);
   else {
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(src);
    if (!response.ok) return;
    blob = await response.blob();
   }
   if (revision !== this.revision) return;
   const tags = (await parseBlob(blob, {skipCovers: false})).common;
   if (revision !== this.revision) return;
   metadata.title = tags.title || text("title");
   metadata.artist = tags.artist || text("artist");
   metadata.album = tags.album || text("album");
   const picture = tags.picture?.[0];
   if (picture) {
    try {
     metadata.artwork = [await mediaArtwork(new Blob([new Uint8Array(picture.data)], {type: picture.format}))];
    } catch { /* Invalid cover art must not discard the track's text tags. */ }
    if (revision !== this.revision) return;
   }
   if (this.session) this.session.metadata = new MediaMetadata({...metadata, title: metadata.title || audioFilename(this.ctrl.active?.src ?? "")});
   this.ctrl.setMetadata(metadata);
  } catch { /* Unavailable tags must never interrupt playback. */ }
 }
 destroy() {
  ++this.revision;
  if (!this.session) return;
  for (const action of this.actions) this.session.setActionHandler(action, null);
  this.session.metadata = null;
  this.session.playbackState = "none";
  try { this.session.setPositionState(); } catch { /* Unsupported host. */ }
 }
}

// Give the native media surface self-contained, bounded artwork rather than a
// webview-scoped blob URL. Normalize embedded formats and declare actual size.
async function mediaArtwork(blob: Blob): Promise<MediaImage> {
 const src = await new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid artwork"));
  reader.onerror = () => reject(reader.error ?? new Error("Unreadable artwork"));
  reader.readAsDataURL(blob);
 });
 const image = new Image();
 await new Promise<void>((resolve, reject) => {
  image.onload = () => resolve();
  image.onerror = () => reject(new Error("Unsupported artwork"));
  image.src = src;
 });
 const canvas = document.createElement("canvas");
 canvas.width = canvas.height = 512;
 const context = canvas.getContext("2d");
 if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error("Invalid artwork dimensions");
 context.fillStyle = "#ffffff";
 context.fillRect(0, 0, 512, 512);
 const scale = Math.min(512 / image.naturalWidth, 512 / image.naturalHeight);
 const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
 context.drawImage(image, (512 - width) / 2, (512 - height) / 2, width, height);
 return {src: canvas.toDataURL("image/jpeg", 0.9), sizes: "512x512", type: "image/jpeg"};
}

// Obsidian may add different cache-busting parameters to the same vault file.
// Remote URLs retain their query because it can identify a distinct recording.
function audioSourceKey(src: string): string {
 return /^(app|capacitor|file):/i.test(src) ? src.split(/[?#]/)[0] : src;
}

function audioFilename(src: string): string {
 const name = src.split(/[?#]/)[0].split("/").pop() || "Audio";
 try { return decodeURIComponent(name); } catch { return name; }
}
