import { App, MarkdownView, Menu, Modal, Platform, Plugin, setIcon, WorkspaceLeaf, ItemView, TFile } from "obsidian";

// -- Types -------------------------------------------------------------------

type QueueTrack = { src: string; note: string };
type Evt = "queue" | "play" | "pause" | "timeupdate" | "ratechange" | "change" | "metadata";
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
	queue: QueueTrack[] = [];
 enqueue(src: string, note: string, next = false) {
  const track = {src, note};
  if (next) this.queue.unshift(track); else this.queue.push(track);
  this.emit("queue");
 }
 removeQueued(index: number) { this.queue.splice(index, 1); this.emit("queue"); }
 moveQueued(index: number, delta: number) {
  const target = index + delta;
  if (index < 0 || index >= this.queue.length || target < 0 || target >= this.queue.length) return;
  const [track] = this.queue.splice(index, 1);
  this.queue.splice(target, 0, track);
  this.emit("queue");
 }
 playQueued(index = 0) {
  const track = this.queue[index];
  if (!track) return;
  this.queue.splice(index, 1);
  this.loadAndPlay(track.src, track.note);
  this.emit("queue");
 }
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
		if (delta > 0 && this.queue.length) return true;
		const index = this.trackIndex + delta;
		return this.trackIndex >= 0 && index >= 0 && index < this.tracks.length;
	}
	skipTrack(delta: number) {
  if (delta > 0 && this.queue.length) { this.playQueued(); return; }
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
    if (this.queue.length) this.playQueued();
    else this.emit("pause");
			}
		});
		el.addEventListener("ratechange", () => { if (el === this.active) this.emit("ratechange"); });
	}

	on(ev: Evt, cb: Cb) {
		let set = this.subs.get(ev);
		if (!set) { set = new Set(); this.subs.set(ev, set); }
		set.add(cb);
  return () => { set?.delete(cb); };
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

class TransportButtons {
 private pendingTrackTap: ReturnType<typeof setTimeout> | null = null;
 private pendingTrackButton: HTMLElement | null = null;
 constructor(private ctrl: Controller) {}
 cancel() {
  if (this.pendingTrackTap !== null) clearTimeout(this.pendingTrackTap);
  this.pendingTrackTap = null;
  this.pendingTrackButton = null;
 }
	create(parent: HTMLElement, icon: string, title: string, delta: number) {
		const button = actionButton(parent, icon, title, () => {
			if (button.disabled) return;
			if (this.pendingTrackButton === button && this.pendingTrackTap !== null) {
				clearTimeout(this.pendingTrackTap);
				this.pendingTrackTap = null;
				this.pendingTrackButton = null;
				this.ctrl.seekBy(delta * 5);
				button.querySelector(".pp-nudge-feedback")?.remove();
				const feedback = button.createSpan({
					cls: "pp-nudge-feedback",
					text: delta < 0 ? "−5" : "+5",
				});
				feedback.setAttribute("aria-hidden", "true");
				feedback.addEventListener("animationend", () => feedback.remove());
				return;
			}
			if (this.pendingTrackTap !== null) clearTimeout(this.pendingTrackTap);
			this.pendingTrackButton = button;
			const audio = this.ctrl.active;
			this.pendingTrackTap = setTimeout(() => {
				this.pendingTrackButton = null;
				this.pendingTrackTap = null;
				if (audio !== this.ctrl.active) return;
				if (delta < 0) this.ctrl.seekBy(-this.ctrl.currentTime);
				else this.ctrl.skipTrack(delta);
			}, 300);
		});
        button.addClass("pp-np-track-button");
        button.addClass(delta < 0 ? "pp-np-previous" : "pp-np-next");
		return button;
	}

}

// One seek-track implementation for the bar, sidebar, and mobile queue.
class SeekTrack {
 readonly element: HTMLElement;
 private track: HTMLElement;
 private fill: HTMLElement;
 private pointer: number | null = null;
 constructor(parent: HTMLElement, private ctrl: Controller) {
  this.element = parent.createDiv("pp-np-center");
  this.element.setAttribute("role", "slider");
  this.element.setAttribute("aria-label", "Playback position");
  this.element.setAttribute("tabindex", "0");
  this.element.setAttribute("aria-valuemin", "0");
  this.track = this.element.createDiv("pp-np-track");
  this.fill = this.track.createDiv("pp-np-fill");
  this.element.addEventListener("pointerdown", event => {
   if (event.button !== 0) return;
   this.pointer = event.pointerId;
   this.element.setPointerCapture(event.pointerId);
   this.seekTo(event.clientX);
  });
  this.element.addEventListener("pointermove", event => { if (this.pointer === event.pointerId) this.seekTo(event.clientX); });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) this.element.addEventListener(event, () => { this.pointer = null; });
  this.element.addEventListener("keydown", event => {
   if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
   event.preventDefault();
   const duration = this.ctrl.duration();
   if (!Number.isFinite(duration) || duration <= 0) return;
   this.ctrl.seek(event.key === "Home" ? 0 : event.key === "End" ? duration : Math.max(0, Math.min(duration, this.ctrl.currentTime + (event.key === "ArrowLeft" ? -5 : 5))));
   this.sync();
  });
  this.sync();
 }
 sync() {
  const duration = this.ctrl.duration();
  const valid = Number.isFinite(duration) && duration > 0;
  const time = valid ? Math.max(0, Math.min(duration, this.ctrl.currentTime)) : 0;
  this.fill.style.width = `${valid ? time / duration * 100 : 0}%`;
  this.element.setAttribute("aria-valuemax", String(valid ? duration : 0));
  this.element.setAttribute("aria-valuenow", String(time));
  this.element.setAttribute("aria-valuetext", `${fmt(time)} / ${fmt(duration)}`);
 }
 private seekTo(x: number) {
  const bounds = this.track.getBoundingClientRect();
  const duration = this.ctrl.duration();
  if (!bounds.width || !Number.isFinite(duration) || duration <= 0) return;
  this.ctrl.seek(Math.max(0, Math.min(1, (x - bounds.left) / bounds.width)) * duration);
  this.sync();
 }
}

class NowPlayingBar {
	private bar: HTMLElement | null = null;
	private playBtn: HTMLElement | null = null;
	private seekTrack: SeekTrack | null = null;
	private timeEl: HTMLElement | null = null;
	private rateEl: HTMLElement | null = null;
	private sourceEl: HTMLElement | null = null;
	private mobileActions: HTMLElement[] = [];
	private panel: Modal | null = null;
	private art: HTMLElement | null = null;
	private previous: HTMLButtonElement | null = null;
	private next: HTMLButtonElement | null = null;
	private identity: HTMLElement | null = null;
	private transport: TransportButtons;

	constructor(private ctrl: Controller, private app: App, _plugin: Plugin, private openQueue: () => void = () => {}) {
		this.transport = new TransportButtons(ctrl);
		ctrl.on("play", () => { this.show(); this.syncIcon(); });
		ctrl.on("change", () => { this.show(); this.syncSource(); this.syncIcon(); this.syncProgress(); this.syncIdentity(); });
		ctrl.on("metadata", () => { this.syncArtwork(); this.syncIdentity(); });
		ctrl.on("pause", () => this.syncIcon());
        ctrl.on("queue", () => this.syncTracks());
		ctrl.on("timeupdate", () => this.syncProgress());
		ctrl.on("ratechange", () => { if (this.rateEl) this.rateEl.textContent = `${this.ctrl.playbackRate}x`; });

	}

	openPlayer() {
        if (Platform.isMobile) {
            if (this.panel) return;
            const panel = new Modal(this.app);
            this.panel = panel;
            panel.modalEl.addClass("pp-mobile-player");
            const surface = new QueueSurface(panel.contentEl, this.ctrl, this.app, () => panel.close());
            panel.onClose = () => { surface.destroy(); this.panel = null; this.show(); };
            panel.open();
            return;
        }
        this.show(); this.playBtn?.focus();
    }

	private mainView(): ItemView | null {
		// Restrict recency to the central workspace; sidebar focus must not
		// relocate the player or change whether its source-note link is shown.
		const view = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
		return view instanceof ItemView ? view : null;
	}

	show() {
		const view = this.mainView();
		if (Platform.isMobile) {
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
		this.previous = this.transport.create(bar, "rewind", "Restart audio (double tap: back 5 seconds)", -1);
        this.playBtn = playbackButton(bar, () => this.ctrl.toggle());
        this.playBtn.addClass("pp-np-play");
        syncPlaybackButton(this.playBtn, this.ctrl.playing);
		this.next = this.transport.create(bar, "fast-forward", "Next audio (double tap: forward 5 seconds)", 1);
		this.syncTracks();
		this.identity = bar.createDiv("pp-np-identity");
		this.syncIdentity();

		this.seekTrack = new SeekTrack(bar, this.ctrl);

		const right = bar.createDiv("pp-np-right");
		this.timeEl = right.createSpan({ cls: "pp-np-time" });
		this.syncProgress();
        this.rateEl = speedButton(right, this.ctrl);
        this.sourceEl = actionButton(right, "external-link", "Open source note", () => {
            if (this.ctrl.notePath) void this.app.workspace.openLinkText(this.ctrl.notePath, "");
        });
        this.sourceEl.addClass("pp-np-source");
        this.syncSource();
  actionButton(right, "list-music", "Queue", this.openQueue);
        const close = actionButton(right, Platform.isMobile ? "square" : "x", Platform.isMobile ? "Stop playback" : "Close player", () => {
            this.ctrl.clearNote(this.ctrl.notePath);
            this.panel?.close();
            this.hide();
        });
        close.addClass("pp-np-close");
        if (Platform.isMobile) close.createSpan({ text: "Stop" });

		vc.insertBefore(bar, vc.firstChild);
	}

	hide() {
		this.transport.cancel();
		this.mobileActions.forEach(el => el.remove());
		this.mobileActions = [];
		this.bar?.remove();
		this.bar = this.playBtn = this.timeEl = this.rateEl = this.sourceEl = null;
		this.seekTrack = null;
		this.art = this.previous = this.next = this.identity = null;
	}


	private syncTracks() {
		for (const button of [this.previous, this.next]) {
			if (!button) continue;
			button.hidden = false;
			button.disabled = !this.ctrl.hasActive || (button === this.next && !this.ctrl.canSkipTrack(1));
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
		this.sourceEl.setAttribute("aria-label", path ? `Open source note: ${path}` : "Audio");
	}


	private syncIcon() {
		if (this.playBtn) syncPlaybackButton(this.playBtn, this.ctrl.playing);
	}

	private syncProgress() {
		const d = this.ctrl.duration();
		const t = this.ctrl.currentTime;
		this.seekTrack?.sync();
		if (this.timeEl) this.timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
	}

	destroy() { this.panel?.close(); this.panel = null; this.hide(); }
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
			setIcon(badge, "volume-2");
			this.badges.add(badge);
		}
	}

	destroy() {
		for (const badge of this.badges) badge.remove();
		this.badges.clear();
	}
}

// Embed cards share the persistent transport; native audio stays available on unload.
class EmbedPlaybackIndicator {
 private cards = new Map<HTMLAudioElement, {row: HTMLElement; button: HTMLButtonElement; hidden: boolean; src: string}>();
 private observer: MutationObserver;
 private destroyed = false;
 constructor(private ctrl: Controller, private app: App, _bar: NowPlayingBar, plugin: Plugin) {
  for (const event of ["play", "pause", "change"] as const) ctrl.on(event, () => this.sync());
  this.observer = new MutationObserver(() => this.sync());
  this.observer.observe(document.body, {childList: true, subtree: true});
  plugin.register(() => this.destroy());
 }
 sync() {
  if (this.destroyed) return;
  const found = new Set<HTMLAudioElement>();
  for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
   if (!(leaf.view instanceof MarkdownView)) continue;
   const note = leaf.view.file?.path ?? "";
   for (const audio of leaf.view.containerEl.querySelectorAll("audio")) {
    const src = audio.src || audio.currentSrc;
    if (!src || audio.hasClass("pp-pooled")) continue;
    found.add(audio);
    let card = this.cards.get(audio);
    if (card && (card.src !== src || card.row.parentElement !== audio.parentElement)) {
     card.row.remove(); audio.hidden = card.hidden; this.cards.delete(audio); card = undefined;
    }
    if (!card && audio.parentElement) {
     const row = createDiv("pp-embed-card");
     const identity = row.createDiv("pp-recording");
     renderRecording(identity, src, {});
     void readTrackMetadata(this.app, src).then(metadata => { if (!this.destroyed && this.cards.get(audio)?.row === row) renderRecording(identity, src, metadata); });
     const actions = row.createDiv("pp-card-actions");
     const button = playbackButton(actions, () => {
      if (audioSourceKey(this.ctrl.active?.src ?? "") === audioSourceKey(src)) this.ctrl.toggle();
      else this.ctrl.loadAndPlay(src, note, Array.from(leaf.view.containerEl.querySelectorAll("audio")).map(el => el.src || el.currentSrc).filter(Boolean));
     });
     actionButton(actions, "list-start", "Play next", () => this.ctrl.enqueue(src, note, true));
     actionButton(actions, "list-plus", "Add to queue", () => this.ctrl.enqueue(src, note));
     card = {row, button, hidden: audio.hidden, src};
     audio.hidden = true;
     audio.parentElement.insertBefore(row, audio.nextSibling);
     this.cards.set(audio, card);
    }
    if (card) {
     const playing = this.ctrl.playing && audioSourceKey(this.ctrl.active?.src ?? "") === audioSourceKey(src);
     syncPlaybackButton(card.button, playing);
    }
   }
  }
  for (const [audio, card] of this.cards) if (!found.has(audio)) { card.row.remove(); audio.hidden = card.hidden; this.cards.delete(audio); }
 }
 destroy() {
  this.destroyed = true; this.observer.disconnect();
  for (const [audio, card] of this.cards) { card.row.remove(); audio.hidden = card.hidden; }
  this.cards.clear();
 }
}

// All plugin-owned controls use native buttons and one visual primitive.
function actionButton(parent: HTMLElement, icon: string | null, label: string, action: () => void) {
 const button = parent.createEl("button", {cls: "clickable-icon pp-button", attr: {type: "button", "aria-label": label}});
 if (icon) setIcon(button, icon);
 button.addEventListener("click", () => { if (!button.disabled) action(); });
 return button;
}
function playbackButton(parent: HTMLElement, action: () => void) {
 return actionButton(parent, "play", "Play", action);
}
function syncPlaybackButton(button: HTMLElement, playing: boolean) {
 const label = playing ? "Pause" : "Play";
 // Avoid mutations on every embed scan (the scanner observes DOM changes).
 if (button.getAttribute("aria-label") === label) return;
 setIcon(button, playing ? "pause" : "play");
 button.setAttribute("aria-label", label);
}
function speedButton(parent: HTMLElement, ctrl: Controller) {
 const button = actionButton(parent, null, "Playback speed", () => {
  const menu = new Menu();
  for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
   menu.addItem(item => item.setTitle(`${rate}\u00d7`).setChecked(ctrl.playbackRate === rate).onClick(() => ctrl.setRate(rate)));
  }
  const bounds = button.getBoundingClientRect();
  menu.showAtPosition({x: bounds.left, y: bounds.bottom + 4});
 });
 button.addClass("pp-np-rate");
 button.setAttribute("aria-haspopup", "menu");
 button.textContent = `${ctrl.playbackRate}x`;
 return button;
}
function renderRecording(parent: HTMLElement, src: string, metadata: MediaMetadataInit) {
 parent.replaceChildren();
 const art = parent.createDiv("pp-cover-small");
 if (metadata.artwork?.[0]) art.createEl("img", {attr: {src: metadata.artwork[0].src, alt: ""}});
 else setIcon(art, "music");
 const text = parent.createDiv("pp-recording-text");
 text.createDiv({cls: "pp-track-title", text: metadata.title || audioFilename(src)});
 for (const value of [metadata.artist, metadata.album]) if (value) text.createDiv({cls: "pp-track-detail", text: value});
}
async function readTrackMetadata(app: App, src: string): Promise<MediaMetadataInit> {
 try {
  const file = app.vault.getFiles().find(file => audioSourceKey(app.vault.getResourcePath(file)) === audioSourceKey(src));
  // Avoid fetching remote recordings merely to display an embed.
  if (!file) return {};
  const {parseBlob} = await import("music-metadata");
  const tags = (await parseBlob(new Blob([await app.vault.readBinary(file)]))).common;
  const result: MediaMetadataInit = {title: tags.title, artist: tags.artist, album: tags.album};
  const picture = tags.picture?.[0];
  if (picture) try { result.artwork = [await mediaArtwork(new Blob([new Uint8Array(picture.data)], {type: picture.format}))]; } catch { /* Keep text tags. */ }
  return result;
 } catch { return {}; }
}
const QUEUE_VIEW = "persistent-player-queue";
class QueueSurface {
 private off: (() => void)[] = [];
 private head!: HTMLElement;
 private transport: TransportButtons;
 private dragCleanups: (() => void)[] = [];
 private metadataCache = new Map<string, Promise<MediaMetadataInit>>();
 private playhead?: SeekTrack;
 private time?: HTMLElement;
 private scroll = () => {
  // Only artwork transforms change; the header and list keep fixed geometry.
  const progress = Platform.isMobile ? Math.max(0, Math.min(1, this.container.scrollTop / 180)) : 1;
  this.container.style.setProperty("--pp-collapse", String(progress));
 };
 constructor(private container: HTMLElement, private ctrl: Controller, private app: App, private close: () => void = () => {}) {
  this.transport = new TransportButtons(ctrl);
  for (const event of ["queue", "change", "metadata", "ratechange"] as const) this.off.push(ctrl.on(event, () => this.render()));
  for (const event of ["play", "pause"] as const) this.off.push(ctrl.on(event, () => {
   const play = this.head.querySelector<HTMLElement>(".pp-np-play");
   if (play) syncPlaybackButton(play, ctrl.playing);
  }));
  this.off.push(ctrl.on("timeupdate", () => this.syncProgress()));
  container.addEventListener("scroll", this.scroll, {passive: true});
  this.render();
 }
 private syncProgress() {
  const duration = this.ctrl.duration();
  this.playhead?.sync();
  if (this.time) this.time.textContent = `${fmt(this.ctrl.currentTime)} / ${fmt(duration)}`;
 }
 render() {
  this.transport.cancel();
  const el = this.container;
  const scrollTop = el.scrollTop;
  this.dragCleanups.forEach(cleanup => cleanup()); this.dragCleanups = [];
  this.playhead = undefined; this.time = undefined;
  el.replaceChildren(); el.addClass("pp-queue");
  this.head = el.createDiv("pp-queue-playing");
  if (this.ctrl.active) {
   const identity = this.head.createDiv("pp-recording");
   renderRecording(identity, this.ctrl.active.src, this.ctrl.metadata);
   const controls = this.head.createDiv("pp-queue-transport");
   this.transport.create(controls, "rewind", "Restart audio (double tap: back 5 seconds)", -1);
   const play = playbackButton(controls, () => this.ctrl.toggle());
   play.addClass("pp-np-play");
   syncPlaybackButton(play, this.ctrl.playing);
   this.transport.create(controls, "fast-forward", "Next audio (double tap: forward 5 seconds)", 1).disabled = !this.ctrl.canSkipTrack(1);
   this.playhead = new SeekTrack(controls, this.ctrl);
   this.time = controls.createSpan("pp-np-time");
   this.syncProgress();
   if (Platform.isMobile) {
    speedButton(controls, this.ctrl);
    const stop = actionButton(controls, "square", "Stop playback", () => { this.ctrl.clearNote(this.ctrl.notePath); this.close(); });
    stop.addClass("pp-np-close");
   }
  } else this.head.hidden = true;
  if (!this.ctrl.queue.length) {
   const empty = el.createDiv("pp-queue-empty");
   empty.createDiv({cls: "pp-queue-empty-title", text: this.ctrl.hasActive ? "Nothing queued" : "Your queue is empty"});
   empty.createDiv({cls: "pp-queue-empty-hint", text: 'Use "Add to queue" on an audio recording.'});
  }
  this.ctrl.queue.forEach((track, index) => {
   const row = el.createDiv("pp-queue-row");
   const identity = row.createDiv("pp-recording");
   const paint = (metadata: MediaMetadataInit) => {
    renderRecording(identity, track.src, metadata);
    const art = identity.querySelector<HTMLElement>(".pp-cover-small")!;
    const play = playbackButton(art, () => this.ctrl.playQueued(index));
    play.setAttribute("aria-label", `Play ${metadata.title || audioFilename(track.src)}`);
    play.addClass("pp-cover-play");
   };
   paint({});
   let metadata = this.metadataCache.get(track.src);
   if (!metadata) { metadata = readTrackMetadata(this.app, track.src); this.metadataCache.set(track.src, metadata); }
   void metadata.then(value => { if (el.contains(row)) paint(value); });
   identity.tabIndex = 0;
   identity.setAttribute("aria-label", `Reorder ${audioFilename(track.src)}. Use Alt and arrow keys to move.`);
   identity.addEventListener("keydown", event => {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
     event.preventDefault(); this.ctrl.moveQueued(index, event.key === "ArrowUp" ? -1 : 1);
     const target = Math.max(0, Math.min(this.ctrl.queue.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
     el.querySelectorAll<HTMLElement>(".pp-queue-row .pp-recording")[target]?.focus();
    }
   });
   let pointer: number | null = null;
   let target = index;
   let dragging = false;
   let startY = 0;
   let hold: ReturnType<typeof setTimeout> | undefined;
   const cancelHold = () => { if (hold !== undefined) clearTimeout(hold); hold = undefined; };
   this.dragCleanups.push(cancelHold);
   identity.addEventListener("pointerdown", event => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    pointer = event.pointerId; target = index;
    startY = event.clientY;
    dragging = event.pointerType !== "touch";
    if (dragging) identity.setPointerCapture(pointer);
    if (dragging) row.addClass("pp-dragging");
    else hold = setTimeout(() => { dragging = true; if (pointer !== null) identity.setPointerCapture(pointer); row.addClass("pp-dragging"); }, 350);
   });
   identity.addEventListener("touchmove", event => { if (dragging) event.preventDefault(); }, {passive: false});
   identity.addEventListener("pointermove", event => {
    if (event.pointerId !== pointer) return;
    if (!dragging) {
     if (Math.abs(event.clientY - startY) > 8) cancelHold();
     return;
    }
    const bounds = el.getBoundingClientRect();
    if (event.clientY < bounds.top + 60) el.scrollTop -= 12;
    if (event.clientY > bounds.bottom - 60) el.scrollTop += 12;
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".pp-queue-row"));
    target = rows.reduce((best, candidate, i) => Math.abs(event.clientY - (candidate.getBoundingClientRect().top + candidate.offsetHeight / 2)) < Math.abs(event.clientY - (rows[best].getBoundingClientRect().top + rows[best].offsetHeight / 2)) ? i : best, 0);
    rows.forEach((candidate, i) => candidate.classList.toggle("pp-drop-target", i === target && i !== index));
   });
   const end = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    cancelHold();
    const wasDragging = dragging; dragging = false;
    pointer = null; row.removeClass("pp-dragging");
    el.querySelectorAll(".pp-drop-target").forEach(item => item.classList.remove("pp-drop-target"));
    if (event.type === "pointerup" && wasDragging && target !== index) this.ctrl.moveQueued(index, target - index);
   };
   identity.addEventListener("pointerup", end);
   identity.addEventListener("pointercancel", end);
   identity.addEventListener("lostpointercapture", end);
   actionButton(row, "x", "Remove from queue", () => this.ctrl.removeQueued(index));
  });
  el.scrollTop = scrollTop; this.scroll();
 }
 destroy() {
  this.transport.cancel();
  this.dragCleanups.forEach(cleanup => cleanup()); this.metadataCache.clear();
  this.off.forEach(off => off()); this.container.removeEventListener("scroll", this.scroll);
  this.container.replaceChildren();
 }
}
class QueueView extends ItemView {
 private surface?: QueueSurface;
 constructor(leaf: WorkspaceLeaf, private ctrl: Controller) { super(leaf); }
 getViewType() { return QUEUE_VIEW; }
 getDisplayText() { return "Player queue"; }
 getIcon() { return "list-music"; }
 async onOpen() { this.surface = new QueueSurface(this.contentEl, this.ctrl, this.app); }
 async onClose() { this.surface?.destroy(); }
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
		this.bar = new NowPlayingBar(this.ctrl, this.app, this, () => { void this.openQueue(); });
  this.registerView(QUEUE_VIEW, leaf => new QueueView(leaf, this.ctrl));
  this.addCommand({id: "open-queue", name: "Open player queue", callback: () => { void this.openQueue(); }});
  this.addRibbonIcon("list-music", "Open player queue", () => { void this.openQueue(); });
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

 private async openQueue() {
  if (Platform.isMobile) { this.bar.openPlayer(); return; }
  const leaf = this.app.workspace.getLeavesOfType(QUEUE_VIEW)[0] ?? this.app.workspace.getRightLeaf(false);
  if (leaf) { await leaf.setViewState({type: QUEUE_VIEW, active: true}); await this.app.workspace.revealLeaf(leaf); }
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
