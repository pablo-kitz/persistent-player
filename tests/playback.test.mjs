import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

const { code } = transformSync(readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), {
	loader: "ts", format: "cjs", target: "es2022",
});

// A small host double: media events are controlled so navigation can be tested
// without a decoder, vault, or running Obsidian instance.
function setup(mobile = false, storedData = null) {
	const mediaListeners = new Map();
 const menus = [];
 const observers = [];
 class MutationObserver {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
 }
 class Menu {
  constructor() { this.items = []; menus.push(this); }
  addItem(cb) { const item = {setTitle(title) {this.title = title; return this;}, setChecked(checked) {this.checked = checked; return this;}, onClick(cb) {this.click = cb; return this;}}; cb(item); this.items.push(item); return this; }
  showAtPosition(position) { this.position = position; }
 }
	class Element {
		constructor(tag = "div", cls = "") {
			this.tag = tag;
			this.cls = cls;
			this.children = [];
			this.parentElement = null;
			this.attributes = {}; this.dataset = {};
			this.style = {setProperty(name, value) { this[name] = value; }};
            this.scrollTop = 0;
			this.listeners = new Map();
			this.textContent = "";
            this.classList = {
             add: cls => { if (!this.hasClass(cls)) this.cls += ` ${cls}`; },
             remove: cls => { this.cls = this.cls.split(" ").filter(x => x !== cls).join(" "); },
             toggle: (cls, value) => { if (value) this.classList.add(cls); else this.classList.remove(cls); },
            };
		}
		replaceChildren() { for (const child of [...this.children]) child.remove(); }
        getBoundingClientRect() { return this.bounds ?? {left: 100, right: 128, top: 0, bottom: 600}; }
        get ownerDocument() { return document; }
        showPopover() { this.popoverOpen = true; }
        get offsetWidth() { return 300; }
        get offsetHeight() { return 64; }
        setPointerCapture(id) { this.pointer = id; }
        removeClass(cls) { this.classList.remove(cls); }
        focus() { this.focused = true; }
        get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
        get firstChild() { return this.children[0] ?? null; }
		hasClass(cls) { return this.cls.split(" ").includes(cls); }
		matches(selector) { return selector.startsWith(".") ? this.hasClass(selector.slice(1)) : this.tag === selector; }
		createEl(tag, options = {}) {
			const child = tag === "audio" ? new Audio() : new Element(tag);
			if (options.attr) Object.assign(child.attributes, options.attr);
            child.cls = typeof options === "string" ? options : options.cls ?? "";
			if (typeof options === "object" && options.text) child.textContent = options.text;
			this.insertBefore(child, null);
			return child;
		}
		createDiv(options) { return this.createEl("div", options); }
		createSpan(options) { return this.createEl("span", options); }
		insertBefore(child, before) {
			child.remove();
			const index = before ? this.children.indexOf(before) : this.children.length;
			this.children.splice(index, 0, child);
			child.parentElement = this;
		}
		remove() {
			if (this.parentElement) {
				const siblings = this.parentElement.children;
				siblings.splice(siblings.indexOf(this), 1);
				this.parentElement = null;
			}
		}
		contains(el) { return el === this || this.children.some(child => child.contains(el)); }
		closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
		querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
		querySelectorAll(selector) {
			return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
		}
		getAttribute(name) { return this.attributes[name]; }
        addClass(cls) { this.classList.add(cls); }
        setAttribute(name, value) { this.attributes[name] = value; }
		getAttribute(name) { return this.attributes[name] ?? null; }
		removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; }
		addEventListener(name, cb) {
			if (!this.listeners.has(name)) this.listeners.set(name, new Set());
			this.listeners.get(name).add(cb);
		}
		removeEventListener(name, cb) { this.listeners.get(name)?.delete(cb); }
		emit(name, extra = {}) { for (const cb of this.listeners.get(name) ?? []) cb({ target: this, type: name, ...extra }); }
	}
	class Audio extends Element {
		constructor() {
			super("audio");
			this.src = "";
			this.paused = true;
			this.ended = false;
			this.currentTime = 0;
			this.duration = 120;
			this.playbackRate = 1;
		}
		play() {
			this.paused = false;
			this.ended = false;
			for (const cb of mediaListeners.get("play") ?? []) cb({ target: this });
			this.emit("play");
			return Promise.resolve();
		}
		pause() { if (!this.paused) { this.paused = true; this.emit("pause"); } }
		load() { this.paused = true; }
	}
	class Modal {
        constructor() { this.modalEl = body.createDiv(); this.contentEl = this.modalEl.createDiv(); }
        setTitle(title) { this.title = title; }
        open() {}
        close() { this.modalEl.remove(); this.onClose?.(); }
    }
    class MarkdownView {
		constructor(path) {
			this.file = { path };
			this.containerEl = workspaceEl.createDiv();
			this.content = this.containerEl.createDiv("view-content");
		}
	}
	MarkdownView.prototype.addAction = function(icon, title, callback) {
        const el = this.containerEl.createDiv("action"); el.icon = icon;
        el.addEventListener("click", callback); return el;
    };
	class Plugin {
  loadData() { return Promise.resolve(storedData); }
  saveData(data) { this.savedData = data; return Promise.resolve(); }
		constructor(app) { this.app = app; this.app.vault = {getFiles: () => [], getAbstractFileByPath: () => null}; this.cleanups = []; this.commands = new Map(); }
		registerDomEvent(target, event, cb) {
			target.addEventListener(event, cb);
			this.cleanups.push(() => target.removeEventListener(event, cb));
		}
		register(cleanup) { this.cleanups.push(cleanup); }
		registerEvent(cleanup) { this.cleanups.push(cleanup); }
		registerView() {}
        addRibbonIcon() {}
        addCommand(command) { this.commands.set(command.id, command); }
		registerView() {}
		addRibbonIcon() {}
	}
	const body = new Element("body");
	const workspaceEl = body.createDiv("workspace");
	const workspaceEvents = new Map();
	const leaves = [];
	let active = null;
	let recentMain = null;
	const workspace = {
		rootSplit: {},
		getMostRecentLeaf: () => recentMain,
		getActiveViewOfType: type => active?.view instanceof type ? active.view : null,
		getLeavesOfType: () => leaves,
		on(event, cb) {
			if (!workspaceEvents.has(event)) workspaceEvents.set(event, new Set());
			workspaceEvents.get(event).add(cb);
			return () => workspaceEvents.get(event).delete(cb);
		},
		openLinkText: async path => { workspace.openedPath = path; },
	};
	const document = {
        documentElement: {clientWidth: 800, clientHeight: 700},
		body,
		addEventListener(event, cb) {
			if (!mediaListeners.has(event)) mediaListeners.set(event, new Set());
			mediaListeners.get(event).add(cb);
		},
		removeEventListener(event, cb) { mediaListeners.get(event)?.delete(cb); },
	};
	const module = { exports: {} };
	runInNewContext(code + "\nmodule.exports.QueueSurface = QueueSurface;", {
		module, exports: module.exports, MutationObserver, document, HTMLAudioElement: Audio, setTimeout, clearTimeout,
		createDiv: cls => new Element("div", cls),
		require: () => ({ MarkdownView, ItemView: MarkdownView, Platform: {isMobile: mobile}, Modal, Menu, TFile: class {}, Plugin, setIcon: (el, icon) => { el.icon = icon; } }),
	});
	const plugin = new module.exports.default({ workspace });
	plugin.onload();
	function note(path, withHeader = true) {
		const leaf = { view: new MarkdownView(path) };
		if (withHeader) {
			leaf.tabHeaderEl = workspaceEl.createDiv();
			const inner = leaf.tabHeaderEl.createDiv("workspace-tab-header-inner");
			inner.createDiv("workspace-tab-header-inner-close-button");
		}
		leaves.push(leaf);
		return leaf;
	}
	function emit(event) { for (const cb of workspaceEvents.get(event) ?? []) cb(); }
	function focus(leaf) { active = leaf; if (!leaf.sidebar) recentMain = leaf; emit("active-leaf-change"); }
	function embed(leaf, src = "app://vault/song.mp3") {
		const audio = leaf.view.content.createEl("audio");
		audio.src = src;
		return audio;
	}
	function start(leaf, src) {
		void embed(leaf, src).play();
		return body.querySelectorAll(".pp-pooled").find(audio => !audio.paused);
	}
	function command(id) { assert.equal(plugin.commands.get(id).checkCallback(false), true); }
	return { queueSurface: el => new module.exports.QueueSurface(el, plugin.ctrl, plugin.app), observers, menus, body, workspace, plugin, leaves, note, focus, emit, embed, start, command };
}

test("navigation to another audio note preserves playback and moves the controls", () => {
	const h = setup();
	const a = h.note("Music/Source.md"), b = h.note("Other.md");
	h.focus(a);
	const audio = h.start(a);
	assert.equal(h.body.querySelector(".pp-np-source").hidden, true);
	audio.currentTime = 37;
	audio.playbackRate = 1.5;
	const untouched = h.embed(b, "app://vault/other.mp3");
	h.focus(b);
	h.emit("file-open");
	h.emit("layout-change");
	assert.equal(audio.paused, false);
	assert.equal(audio.currentTime, 37);
	assert.equal(audio.playbackRate, 1.5);
	assert.equal(untouched.src, "app://vault/other.mp3");
	assert.equal(h.body.querySelectorAll(".pp-now-playing").length, 1);
	assert.ok(b.view.content.querySelector(".pp-now-playing"));
	const source = b.view.content.querySelector(".pp-np-source");
	assert.equal(source.hidden, false);
	assert.equal(source.parentElement.cls, "pp-np-right");
	assert.equal(source.icon, "external-link");
	assert.ok(a.tabHeaderEl.querySelector(".pp-tab-playing"));
	assert.equal(b.tabHeaderEl.querySelector(".pp-tab-playing"), null);
	b.view.content.querySelector(".pp-np-source").emit("click");
	assert.equal(h.workspace.openedPath, "Music/Source.md");
});

test("opening a file in the same leaf and closing the source do not pause playback", () => {
	const h = setup();
	const a = h.note("Source.md");
	h.focus(a);
	const audio = h.start(a);
	a.view.file = { path: "Replacement.md" };
	h.emit("file-open");
	assert.equal(h.body.querySelector(".pp-np-source").hidden, false);
	assert.equal(audio.paused, false);
	assert.equal(h.body.querySelector(".pp-tab-playing"), null);
	a.view.file = { path: "Source.md" };
	h.emit("file-open");
	assert.equal(h.body.querySelector(".pp-np-source").hidden, true);
	const b = h.note("Destination.md");
	h.focus(b);
	h.leaves.splice(h.leaves.indexOf(a), 1);
	a.view.containerEl.remove();
	h.emit("layout-change");
	assert.equal(audio.paused, false);
	assert.ok(b.view.content.querySelector(".pp-now-playing"));
});

test("pause, resume, end, and close update the source badge and controls", () => {
	const h = setup();
	const a = h.note("Source.md");
	h.focus(a);
	const audio = h.start(a);
	h.command("toggle-playback");
	assert.equal(audio.paused, true);
	assert.equal(h.body.querySelector(".pp-tab-playing"), null);
	assert.ok(h.body.querySelector(".pp-now-playing"));
	h.command("toggle-playback");
	assert.ok(h.body.querySelector(".pp-tab-playing"));
	audio.ended = true;
	audio.emit("ended");
	assert.equal(h.body.querySelector(".pp-tab-playing"), null);
	assert.equal(audio.currentTime, 0);
	h.command("toggle-playback");
	h.body.querySelector(".pp-np-close").emit("click");
	assert.equal(audio.paused, true);
	assert.equal(h.body.querySelector(".pp-pooled"), null);
	assert.equal(h.body.querySelector(".pp-now-playing"), null);
	assert.equal(h.body.querySelector(".pp-tab-playing"), null);
});

test("an explicit new embed switches playback and keeps its actual source in split panes", () => {
	const h = setup();
	const a = h.note("First.md"), b = h.note("Second.md");
	h.focus(a);
	const first = h.start(a);
	first.currentTime = 19;
	const second = h.start(b, "app://vault/second.mp3");
	assert.equal(first.paused, true);
	assert.equal(second.paused, false);
	assert.equal(a.tabHeaderEl.querySelector(".pp-tab-playing"), null);
	assert.ok(b.tabHeaderEl.querySelector(".pp-tab-playing"));
	assert.equal(h.body.querySelector(".pp-np-source").attributes["aria-label"], "Open source note: Second.md");
	assert.equal(h.start(a), first);
	assert.equal(first.currentTime, 19);
	assert.equal(second.paused, true);
	assert.equal(h.body.querySelector(".pp-np-source").attributes["aria-label"], "Open source note: First.md");
});

test("non-Markdown focus hides only the controls; missing tab headers are safe", () => {
	const h = setup();
	const a = h.note("Source.md", false);
	h.focus(a);
	const audio = h.start(a);
	h.focus({ view: {} });
	assert.equal(audio.paused, false);
	assert.equal(h.body.querySelector(".pp-now-playing"), null);
	h.command("skip-forward-5");
	assert.equal(audio.currentTime, 5);
	h.focus(a);
	assert.ok(h.body.querySelector(".pp-now-playing"));
	h.plugin.onunload();
	for (const cleanup of h.plugin.cleanups) cleanup();
	assert.equal(audio.paused, true);
	assert.equal(h.body.querySelector(".pp-pooled"), null);
	assert.equal(h.body.querySelector(".pp-now-playing"), null);
});


test("transport single taps restart or advance, and double taps nudge", async () => {
 const h = setup(); const a = h.note("Playlist.md"); h.focus(a);
 const first = h.embed(a, "app://vault/first.mp3");
 h.embed(a, "app://vault/second.mp3");
 void first.play();
 const back = h.body.querySelector(".pp-np-previous");
 const next = h.body.querySelector(".pp-np-next");
 const audio = h.body.querySelector(".pp-pooled");
 const settle = () => new Promise(resolve => setTimeout(resolve, 330));
 assert.equal(back.icon, "rewind"); assert.equal(next.icon, "fast-forward");
 audio.currentTime = 40;
 back.emit("click"); back.emit("click");
 assert.equal(audio.currentTime, 35);
 await settle(); assert.equal(audio.currentTime, 35);
 next.emit("click"); next.emit("click");
 assert.equal(audio.currentTime, 40);
 assert.equal(audio.src, "app://vault/first.mp3");
 back.emit("click"); await settle();
 assert.equal(audio.currentTime, 0); assert.equal(audio.paused, false);
 next.emit("click"); await settle();
 assert.equal(audio.src, "app://vault/second.mp3");
 assert.equal(next.disabled, true);
 audio.currentTime = 118;
 next.emit("click"); next.emit("click");
 assert.equal(audio.currentTime, 118);
 audio.currentTime = 2;
 back.emit("click"); back.emit("click");
 assert.equal(audio.currentTime, 0);
 audio.pause(); audio.currentTime = 20;
 back.emit("click"); await settle();
 assert.equal(audio.currentTime, 0); assert.equal(audio.paused, true);
});
test("mobile exposes one music action and opens the queue-first player", () => {
 const h = setup(true); const a = h.note("Song.md"); h.focus(a); h.start(a);
 let actions = h.body.querySelectorAll(".action");
 assert.equal(actions.length, 1); assert.equal(actions[0].icon, "music");
 actions[0].emit("click");
 assert.ok(h.body.querySelector(".pp-mobile-player"));
 h.plugin.commands.get("open-queue").callback();
 h.plugin.commands.get("open-queue").callback();
 assert.equal(h.body.querySelectorAll(".pp-mobile-player").length, 1);
 assert.equal(h.body.querySelector(".pp-cover-small").icon, "music");
 h.body.querySelector(".pp-np-play").emit("click");
 assert.equal(h.body.querySelector(".pp-pooled").paused, true);
 h.body.querySelector(".pp-np-close").emit("click");
 assert.equal(h.body.querySelector(".pp-now-playing"), null);
 assert.equal(h.body.querySelectorAll(".action").length, 0);
});

test("native artwork is a sized JPEG data URL and preserves cover proportions", async () => {
 const draws = [];
 const canvas = { toDataURL: (type, quality) => {
  assert.equal(type, "image/jpeg"); assert.equal(quality, 0.9);
  return "data:image/jpeg;base64,cover";
 }, getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) }) };
 class FileReader {
  readAsDataURL() { this.result = "data:image/png;base64,original"; this.onload(); }
 }
 class Image {
  naturalWidth = 1000; naturalHeight = 500;
  set src(value) { assert.equal(value, "data:image/png;base64,original"); this.onload(); }
 }
 const context = { module: {exports: {}}, require: () => ({Plugin: class {}, ItemView: class {}}), FileReader, Image,
  document: {createElement: () => canvas} };
 runInNewContext(code + "\nmodule.exports.artwork = mediaArtwork;", context);
 const artwork = await context.module.exports.artwork({});
 assert.equal(artwork.src, "data:image/jpeg;base64,cover");
 assert.equal(artwork.sizes, "512x512");
 assert.equal(artwork.type, "image/jpeg");
 assert.equal(canvas.width, 512); assert.equal(canvas.height, 512);
 assert.deepEqual(draws[0].slice(1), [0, 128, 512, 256]);
 Image.prototype.naturalWidth = 0;
 class BrokenImage { set src(value) { this.onerror(); } }
 context.Image = BrokenImage;
 await assert.rejects(context.module.exports.artwork({}), /Unsupported artwork/);
});

for (const mobile of [false, true]) {
 test(`transport order with multiple tracks (${mobile ? "mobile" : "desktop"})`, () => {
  const h = setup(mobile); const a = h.note("Playlist.md"); h.focus(a);
  const first = h.embed(a, "app://vault/first.mp3");
  h.embed(a, "app://vault/second.mp3"); void first.play();
  if (mobile) h.body.querySelector(".action").emit("click");
  const bar = h.body.querySelector(mobile ? ".pp-queue-transport" : ".pp-now-playing");
  assert.equal(bar.querySelector(".pp-np-skip"), null);
  for (const button of bar.querySelectorAll(".clickable-icon")) assert.equal(button.getAttribute("title"), null);
  const controls = bar.children.filter(el => el.hasClass("pp-np-play") || el.hasClass("pp-np-track-button"));
  assert.deepEqual(controls.map(el => el.attributes["aria-label"]), ["Restart audio (double tap: back 5 seconds)", "Pause", "Next audio (double tap: forward 5 seconds)"]);
  if (!mobile) assert.deepEqual(bar.querySelector(".pp-np-right").children.map(el => el.attributes["aria-label"]),
   [undefined, "Playback speed", "Volume", "Open source note: Playlist.md", "Queue", "Close player"]);
 });
}

test("duplicate local audio renders do not create a next track", () => {
 const h = setup(); const a = h.note("Single.md"); h.focus(a);
 const first = h.embed(a, "app://vault/song.mp3?mtime=1");
 h.embed(a, "app://vault/song.mp3?mtime=2"); void first.play();
 for (const button of h.body.querySelectorAll(".pp-np-track-button")) {
  assert.equal(button.hidden, false); assert.equal(button.disabled, button.hasClass("pp-np-next"));
 }
 assert.equal(h.plugin.ctrl.canSkipTrack(1), false);
 const stop = h.body.querySelector(".pp-np-close");
 assert.equal(stop.icon, "x"); assert.equal(stop.attributes["aria-label"], "Close player");
 stop.emit("click"); assert.equal(h.body.querySelector(".pp-pooled"), null);
});

test("source embeds exclude cover art and plugin audio from the single-track note", () => {
 const h = setup(); const a = h.note("Elderberry Wine.md"); h.focus(a);
 const audioPath = "Repertoire/Wednesday - Elderberry Wine/Wednesday - Elderberry Wine.mp3";
 const coverPath = "Repertoire/Wednesday - Elderberry Wine/cover.jpg";
 h.plugin.app.metadataCache = {
  getFileCache: () => ({embeds: [{link: audioPath}, {link: coverPath}]}),
  getFirstLinkpathDest: link => ({path: link, extension: link.split(".").pop()}),
 };
 h.plugin.app.vault = {getAbstractFileByPath: () => null, getFiles: () => [], getAbstractFileByPath: () => null, getResourcePath: file => `app://vault/${file.path}`};
 const first = h.embed(a, `app://vault/${audioPath}?mtime=1`);
 h.embed(a, "app://vault/plugin-generated.mp3");
 void first.play();
 for (const button of h.body.querySelectorAll(".pp-np-track-button")) assert.equal(button.disabled, button.hasClass("pp-np-next"));
});


test("desktop recording label falls back to filename and metadata exposes artwork details", () => {
 const h = setup(); const a = h.note("Source.md"); h.focus(a);
 h.start(a, "app://vault/My%20recording.mp3");
 assert.equal(h.body.querySelector(".pp-np-title").textContent, "My recording.mp3");
 assert.equal(h.body.querySelector(".pp-track-card"), null);
 h.plugin.ctrl.setMetadata({title: "Elderberry Wine", artist: "Wednesday", album: "Bleeds", artwork: [{src: "data:image/jpeg;base64,cover"}]});
 assert.equal(h.body.querySelector(".pp-np-title").textContent, "Elderberry Wine");
 assert.equal(h.body.querySelector(".pp-np-title").attributes.tabindex, "0");
 assert.equal(h.body.querySelector(".pp-track-card").querySelector("img").src, "data:image/jpeg;base64,cover");
 assert.deepEqual(h.body.querySelectorAll(".pp-track-detail").map(el => el.textContent), ["Wednesday", "Bleeds"]);
 h.start(a, "app://vault/Other.mp3");
 assert.equal(h.body.querySelector(".pp-track-card"), null);
 assert.equal(h.body.querySelector(".pp-np-title").textContent, "Other.mp3");
});


for (const mobile of [false, true]) {
 test(`sidebar focus keeps player attached to main pane (${mobile ? "mobile" : "desktop"})`, () => {
  const h = setup(mobile); const source = h.note("Source.md"); h.focus(source);
  const audio = h.start(source);
  const sidebar = h.note("Sidebar.md"); sidebar.sidebar = true;
  h.focus(sidebar); h.emit("layout-change");
  assert.equal(audio.paused, false);
  if (mobile) {
   assert.equal(sidebar.view.containerEl.querySelector(".action"), null);
   assert.ok(source.view.containerEl.querySelector(".action"));
  } else {
   assert.equal(sidebar.view.content.querySelector(".pp-now-playing"), null);
   assert.ok(source.view.content.querySelector(".pp-now-playing"));
   assert.equal(h.body.querySelector(".pp-np-source").hidden, true);
   const other = h.note("Other.md"); h.focus(other); h.focus(sidebar);
   assert.ok(other.view.content.querySelector(".pp-now-playing"));
   assert.equal(h.body.querySelector(".pp-np-source").hidden, false);
  }
 });
}


test("speed opens a checked selection menu and source icon precedes close", () => {
 const h = setup(); const source = h.note("Source.md"); h.focus(source); h.start(source);
 const other = h.note("Other.md"); h.focus(other);
 const icon = h.body.querySelector(".pp-np-source");
 assert.equal(icon.icon, "external-link");
 assert.equal(icon.querySelector(".pp-source-arrow"), null);
 const siblings = icon.parentElement.children;
 assert.equal(siblings[siblings.indexOf(icon) + 1].getAttribute("aria-label"), "Queue");
 assert.equal(siblings[siblings.indexOf(icon) + 2].hasClass("pp-np-close"), true);
 const speed = h.body.querySelector(".pp-np-rate");
 speed.emit("click");
 assert.equal(speed.textContent, "1x");
 const choices = h.body.querySelectorAll(".pp-tuning-speed");
 assert.deepEqual(choices.map(button => button.textContent), ["0.5x", "0.75x", "1x", "1.25x", "1.5x", "2x"]);
 assert.equal(choices[2].getAttribute("aria-pressed"), "true");
 choices[4].emit("click");
 assert.equal(choices[4].getAttribute("aria-pressed"), "true");
 assert.equal(h.body.querySelectorAll(".pp-tuning-slider").length, 2);
 assert.equal(speed.textContent, "1.5x");
});


for (const mobile of [false, true]) {
 test(`embed cards share transport and restore native audio (${mobile})`, () => {
  const h = setup(mobile); const a = h.note("Source.md"); h.focus(a);
  const first = h.embed(a, "app://vault/first.mp3");
  h.observers[0].callback();
  const card = first.nextSibling;
  assert.equal(card.hasClass("pp-embed-card"), true);
  assert.equal(first.hidden, true);
  const buttons = card.querySelectorAll("button");
  buttons[0].emit("click");
  assert.equal(h.plugin.ctrl.playing, true);
  assert.equal(buttons[0].getAttribute("aria-label"), "Pause");
  buttons[0].emit("click");
  assert.equal(h.plugin.ctrl.playing, false);
  buttons[2].emit("click"); buttons[1].emit("click");
  assert.equal(h.plugin.ctrl.queue.length, 2);
  h.plugin.onunload();
  assert.equal(first.hidden, undefined);
  assert.equal(card.parentElement, null);
 });
}
test("queue orders across notes, removes duplicates independently and advances on end", () => {
 const h = setup(); const ctrl = h.plugin.ctrl;
 ctrl.enqueue("app://vault/a.mp3", "A.md");
 ctrl.enqueue("app://vault/b.mp3", "B.md", true);
 ctrl.enqueue("app://vault/a.mp3", "A.md");
 ctrl.moveQueued(2, -1);
 assert.deepEqual(Array.from(ctrl.queue, t => t.note), ["B.md", "A.md", "A.md"]);
 ctrl.removeQueued(1);
 ctrl.playQueued();
 assert.equal(ctrl.notePath, "B.md");
 ctrl.active.emit("ended");
 assert.equal(ctrl.notePath, "A.md");
 assert.equal(ctrl.queue.length, 0);
 ctrl.moveQueued(0, -1);
});

test("dragging across several queue rows inserts without disturbing intervening order", () => {
 const h = setup(); const ctrl = h.plugin.ctrl;
 for (const name of ["a", "b", "c", "d"]) ctrl.enqueue(`app://vault/${name}.mp3`, `${name}.md`);
 ctrl.moveQueued(0, 3);
 assert.deepEqual(Array.from(ctrl.queue, t => t.note), ["b.md", "c.md", "d.md", "a.md"]);
 ctrl.moveQueued(3, -2);
 assert.deepEqual(Array.from(ctrl.queue, t => t.note), ["b.md", "a.md", "c.md", "d.md"]);
 ctrl.moveQueued(0, -1);
 assert.equal(ctrl.queue[0].note, "b.md");
});

for (const mobile of [false, true]) {
 test(`queue surface preserves scroll, updates seek and cleans up (${mobile})`, () => {
  const h = setup(mobile), ctrl = h.plugin.ctrl;
  ctrl.loadAndPlay("app://vault/a.mp3", "A.md");
  ctrl.enqueue("app://vault/b.mp3", "B.md");
  const el = h.body.createDiv(); const surface = h.queueSurface(el);
  el.scrollTop = 90; el.emit("scroll");
  assert.equal(el.style["--pp-collapse"], undefined);
  ctrl.enqueue("app://vault/c.mp3", "C.md");
  assert.equal(el.scrollTop, 90);
  const seek = el.querySelector(".pp-np-center");
  assert.equal(el.querySelector("input"), null);
  el.querySelector(".pp-np-track").bounds = {left: 0, width: 120};
  seek.emit("pointerdown", {button: 0, pointerId: 1, clientX: 42});
  seek.emit("pointerup", {pointerId: 1});
  assert.equal(ctrl.currentTime, 42);
  ctrl.active.emit("timeupdate"); assert.equal(seek.getAttribute("aria-valuenow"), "42");
  el.scrollTop = -10; el.emit("scroll");
  assert.equal(el.style["--pp-collapse"], undefined);
  surface.destroy(); ctrl.enqueue("app://vault/d.mp3", "D.md");
  assert.equal(el.children.length, 0);
 });
}
test("queue pointer cancellation never commits and touch swipes scroll instead of reorder", () => {
 const h = setup(true), ctrl = h.plugin.ctrl;
 for (const name of ["a", "b", "c"]) ctrl.enqueue(`app://vault/${name}.mp3`, `${name}.md`);
 const el = h.body.createDiv(); const surface = h.queueSurface(el);
 const rows = el.querySelectorAll(".pp-queue-row");
 rows.forEach((row, i) => { row.bounds = {top: 100 + i * 64}; });
 const identity = rows[0].querySelector(".pp-recording");
 identity.emit("pointerdown", {pointerId: 1, pointerType: "mouse", button: 0, clientY: 120});
 identity.emit("pointermove", {pointerId: 1, clientY: 250});
 identity.emit("pointercancel", {pointerId: 1});
 assert.equal(ctrl.queue[0].note, "a.md");
 assert.equal(rows[0].hasClass("pp-dragging"), false);
 identity.emit("pointerdown", {pointerId: 2, pointerType: "touch", button: 0, clientY: 200});
 identity.emit("pointermove", {pointerId: 2, clientY: 150});
 identity.emit("pointerup", {pointerId: 2});
 assert.equal(el.scrollTop, 0); // Browser owns touch scrolling; no synthetic scroll jumps.
 assert.equal(ctrl.queue[0].note, "a.md");
 identity.emit("pointerdown", {pointerId: 3, pointerType: "mouse", button: 0, clientY: 120});
 identity.emit("pointermove", {pointerId: 3, clientY: 250});
 identity.emit("pointerup", {pointerId: 3});
 assert.deepEqual(Array.from(ctrl.queue, t => t.note), ["b.md", "c.md", "a.md"]);
 surface.destroy();
});

for (const mobile of [false, true]) {
 test(`queue transport shares desktop icons and double-tap nudges (${mobile})`, async () => {
  const h = setup(mobile); const ctrl = h.plugin.ctrl;
  ctrl.loadAndPlay("app://vault/a.mp3", "A.md");
  ctrl.enqueue("app://vault/b.mp3", "B.md");
  const el = h.body.createDiv(); const surface = h.queueSurface(el);
  await new Promise(resolve => setTimeout(resolve, 0));
  const controls = el.querySelector(".pp-queue-transport");
  const buttons = controls.querySelectorAll("button");
  assert.equal(buttons.length, mobile ? 3 : 4);
  assert.equal(el.querySelector(".pp-queue-nudge"), null);
  if (mobile) assert.equal(el.querySelector(".pp-np-rate").textContent, "1x");
  assert.deepEqual(buttons.slice(0, 3).map(button => button.icon), ["rewind", "pause", "fast-forward"]);
  for (const button of buttons) assert.equal(button.getAttribute("title"), null);
  ctrl.active.currentTime = 40;
  buttons[0].emit("click"); buttons[0].emit("click");
  assert.equal(ctrl.currentTime, 35);
  assert.equal(buttons[0].querySelector(".pp-nudge-feedback").textContent, "\u22125");
  buttons[2].emit("click"); buttons[2].emit("click");
  assert.equal(ctrl.currentTime, 40);
  assert.equal(buttons[2].querySelector(".pp-nudge-feedback").textContent, "+5");
  assert.equal(ctrl.queue.length, 1);
  buttons[0].emit("click");
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.equal(ctrl.currentTime, 0);
  buttons[2].emit("click");
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.equal(ctrl.notePath, "B.md");
  ctrl.active.currentTime = 40;
  buttons[0].emit("click");
  surface.destroy();
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.equal(ctrl.currentTime, 40);
 });
}

for (const mobile of [false, true]) {
 test(`all controls share native button semantics and playback state (${mobile})`, () => {
  const h = setup(mobile); const note = h.note("Buttons.md"); h.focus(note);
  const audio = h.embed(note); void audio.play();
  if (mobile) h.body.querySelector(".action").emit("click");
  const queue = h.body.createDiv(); const surface = h.queueSurface(queue);
  const buttons = h.body.querySelectorAll("button");
  assert.ok(buttons.length > 8);
  for (const button of buttons) {
   assert.equal(button.hasClass("pp-button"), true);
   assert.equal(button.getAttribute("type"), "button");
   assert.ok(button.getAttribute("aria-label"));
   assert.equal(button.getAttribute("title"), null);
  }
  const barPlay = h.body.querySelector(".pp-np-play");
  assert.equal(barPlay.tag, "button");
  assert.equal(h.body.querySelector(".pp-np-close").tag, "button");
  barPlay.emit("click");
  assert.equal(barPlay.getAttribute("aria-label"), "Play");
  assert.equal(audio.nextSibling.querySelector("button").getAttribute("aria-label"), "Play");
  const queuePlay = queue.querySelectorAll("button").find(button => button.getAttribute("aria-label") === "Play");
  queuePlay.emit("click");
  assert.equal(h.plugin.ctrl.playing, true);
  assert.equal(audio.nextSibling.querySelector("button").getAttribute("aria-label"), "Pause");
  const next = h.body.querySelector(".pp-np-next");
  assert.equal(next.disabled, true);
  h.plugin.ctrl.enqueue("app://vault/next.mp3", "Next.md");
  assert.equal(h.body.querySelector(".pp-np-next").disabled, false);
  surface.destroy();
 });
}

 test("tuning follows recording sources and persists cents", async () => {
  const h = setup(), ctrl = h.plugin.ctrl;
  await Promise.resolve();
  ctrl.loadAndPlay("app://vault/a.mp3?mtime=1", "A.md");
  ctrl.setDetune(-35);
  assert.ok(Math.abs(ctrl.active.playbackRate - 2 ** (-35 / 1200)) < 1e-10);
  assert.equal(ctrl.active.preservesPitch, false);
  ctrl.loadAndPlay("app://vault/b.mp3", "A.md");
  assert.equal(ctrl.detune, 0);
  assert.equal(ctrl.active.preservesPitch, true);
  ctrl.loadAndPlay("app://vault/a.mp3?mtime=2", "Other.md");
  assert.equal(ctrl.detune, -35);
  ctrl.setRate(0.75);
  assert.ok(Math.abs(ctrl.active.playbackRate - 0.75 * 2 ** (-35 / 1200)) < 1e-10);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.plugin.savedData.detunes["app://vault/a.mp3"], -35);
  ctrl.restoreDetunes({"app://vault/c.mp3": 125});
  ctrl.loadAndPlay("app://vault/c.mp3", "C.md");
  assert.equal(ctrl.detune, 125);
  ctrl.setDetune(0);
  assert.equal(ctrl.active.playbackRate, 0.75);
 });

test("embed display tuning preserves labels, targets and surrounding Markdown", () => {
 const context = {module: {exports: {}}, require: () => ({Plugin: class {}, ItemView: class {}})};
 runInNewContext(code + "\nmodule.exports.helpers = {replaceEmbedTuning, embedTuningValue};", context);
 const {replaceEmbedTuning, embedTuningValue} = context.module.exports.helpers;
 const update = (original, cents, tail = " after\n") => {
  const content = `Before\n${original}${tail}`;
  const embed = {original, position: {start: {offset: 7}, end: {offset: 7 + original.length}}};
  return replaceEmbedTuning(content, [embed], cents);
 };
 assert.equal(update("![[song.mp3]]", -35), "Before\n![[song.mp3|detune=-35]] after\n");
 assert.equal(update("![[song.mp3|My song]]", 120), "Before\n![[song.mp3|My song detune=120]] after\n");
 assert.equal(update("![[song.mp3|My song detune=-35]]", 0), "Before\n![[song.mp3|My song detune=0]] after\n");
 assert.equal(update("![My song](folder/song%20name.mp3)", -35), "Before\n![My song detune=-35](folder/song%20name.mp3) after\n");
 assert.equal(update("![[song.mp3]]", 50, " <!-- persistent-player:detune=-35 --> prose"), "Before\n![[song.mp3|detune=50]] prose");
 assert.equal(embedTuningValue("![[renamed song.mp3|detune=-35]]"), -35);
 assert.equal(embedTuningValue("![Song detune=+120](song.mp3)"), 120);
 assert.equal(embedTuningValue("![[song.mp3]]", " <!-- persistent-player:detune=-35 -->"), -35);
 assert.equal(embedTuningValue("![[song.mp3|detune=0]]", " <!-- persistent-player:detune=-35 -->"), 0);
 for (const value of ["garbage", "1300", "2.5", "Infinity"]) assert.equal(embedTuningValue(`![[song.mp3|detune=${value}]]`), 0);
 const original = "![[song.mp3]]";
 assert.throws(() => replaceEmbedTuning("Changed " + original, [{original, position: {start: {offset: 0}, end: {offset: original.length}}}], 0), /Embed changed/);
 const second = "![[other.mp3|Other]]";
 const both = original + "\n" + second;
 const refs = [original, second].map((original, i) => ({original, position: {start: {offset: i ? both.indexOf(second) : 0}, end: {offset: (i ? both.indexOf(second) : 0) + original.length}}}));
 assert.equal(replaceEmbedTuning(both, refs, 25), "![[song.mp3|detune=25]]\n![[other.mp3|Other detune=25]]");
});

test("async embed tuning is applied before playback and an obsolete read cannot switch songs", async () => {
 const h = setup(), ctrl = h.plugin.ctrl;
 const reads = [];
 ctrl.readTuning = () => new Promise(resolve => reads.push(resolve));
 ctrl.loadAndPlay("app://vault/a.mp3", "A.md");
 ctrl.loadAndPlay("app://vault/b.mp3", "B.md");
 reads[1](50); await Promise.resolve();
 assert.equal(ctrl.notePath, "B.md");
 assert.equal(ctrl.detune, 50);
 reads[0](-35); await Promise.resolve();
 assert.equal(ctrl.notePath, "B.md");
 assert.equal(ctrl.detune, 50);
});

test("rapid tuning saves work before Obsidian refreshes embed positions", async () => {
 class TFile {}
 const file = new TFile();
 const original = "![[song.mp3]]";
 let content = original + "\n" + original;
 const refs = [0, original.length + 1].map(offset => ({original, link: "song.mp3", position: {start: {offset}, end: {offset: offset + original.length}}}));
 const app = {
  vault: {getAbstractFileByPath: () => file, getResourcePath: () => "app://vault/song.mp3", cachedRead: async () => content, process: async (_file, callback) => {content = callback(content);}},
  metadataCache: {getFileCache: () => ({embeds: refs}), getFirstLinkpathDest: () => file},
 };
 const context = {module: {exports: {}}, require: () => ({TFile, Plugin: class {}, ItemView: class {}})};
 runInNewContext(code + "\nmodule.exports.EmbedTuning = EmbedTuning;", context);
 const tuning = new context.module.exports.EmbedTuning(app);
 await tuning.save("app://vault/song.mp3", "Note.md", -3);
 await tuning.save("app://vault/song.mp3", "Note.md", -35);
 assert.equal(content, "![[song.mp3|detune=-35]]\n![[song.mp3|detune=-35]]");
 assert.equal(await tuning.read("app://vault/song.mp3", "Note.md"), -35);
});

for (const mobile of [false, true]) {
 test(`tuning panel sliders apply, reset and close when recording changes (${mobile})`, () => {
  const h = setup(mobile), note = h.note("Song.md"); h.focus(note); h.start(note);
  h.plugin.ctrl.setDetune(-135);
  if (mobile) h.body.querySelector(".action").emit("click");
  h.body.querySelector(".pp-np-rate").emit("click");
  const panel = h.body.querySelector(".pp-playback-popover");
  const sliders = panel.querySelectorAll("input");
  assert.equal(sliders.length, 2);
  assert.deepEqual(sliders.map(input => input.getAttribute("type")), ["range", "range"]);
  assert.deepEqual(sliders.map(input => input.value), ["-1", "-35"]);
  sliders[1].value = "25"; sliders[1].emit("input");
  assert.equal(h.plugin.ctrl.detune, -75);
  assert.equal(h.body.querySelector(".pp-playback-popover"), panel);
  assert.equal(panel.querySelector(".pp-tuning-total").textContent, "-75 cents total");
  assert.equal(sliders[1].getAttribute("aria-valuetext"), "+25 cents");
  panel.querySelector(".pp-tuning-reset").emit("click");
  assert.equal(h.plugin.ctrl.detune, 0);
  assert.deepEqual(sliders.map(input => input.value), ["0", "0"]);
  assert.equal(panel.querySelector(".pp-tuning-reset").disabled, true);
  h.plugin.ctrl.loadAndPlay("app://vault/next.mp3", "Next.md");
  assert.equal(h.body.querySelector(".pp-playback-popover"), null);
 });
}

test("playback popover dismisses cleanly and is removed on plugin unload", () => {
 const h = setup(), note = h.note("Song.md"); h.focus(note); h.start(note);
 const button = h.body.querySelector(".pp-np-rate");
 button.emit("click");
 assert.equal(button.getAttribute("aria-expanded"), "true");
 const popover = h.body.querySelector(".pp-playback-popover");
 assert.equal(popover.getAttribute("popover"), "auto");
 popover.emit("toggle", {newState: "closed"});
 assert.equal(h.body.querySelector(".pp-playback-popover"), null);
 assert.equal(button.getAttribute("aria-expanded"), "false");
 button.emit("click"); button.emit("click");
 assert.equal(h.body.querySelectorAll(".pp-playback-popover").length, 1);
 h.plugin.onunload();
 assert.equal(h.body.querySelector(".pp-playback-popover"), null);
});


for (const mobile of [false, true]) {
 test(`Space toggles only the focused player without activating its focused button (${mobile})`, () => {
  const h = setup(mobile), note = h.note("Space.md"); h.focus(note); h.start(note);
  if (mobile) h.body.querySelector(".action").emit("click");
  const player = h.body.querySelector(mobile ? ".pp-queue-playing" : ".pp-now-playing");
  const target = player.querySelector(".pp-np-next");
  let prevented = 0, stopped = 0;
  const event = {key: " ", target, preventDefault() { prevented++; }, stopPropagation() { stopped++; }};
  player.emit("keydown", event);
  assert.equal(h.plugin.ctrl.playing, false);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  player.emit("keydown", {...event, repeat: true});
  assert.equal(h.plugin.ctrl.playing, false);
  player.emit("keyup", event);
  assert.equal(prevented, 3);
  player.emit("keydown", {...event, ctrlKey: true});
  assert.equal(h.plugin.ctrl.playing, false);
  const input = player.createEl("input"); input.type = "text";
  player.emit("keydown", {...event, target: input});
  assert.equal(prevented, 3);
  player.emit("keydown", {...event, target: player.querySelector(".pp-np-center")});
  assert.equal(h.plugin.ctrl.playing, true);
 });
}

for (const mobile of [false, true]) {
 test(`volume uses a native popover slider and persists across sessions (${mobile})`, async () => {
  const h = setup(mobile, {volume: 0.37, unrelated: "preserved"});
  await Promise.resolve();
  const note = h.note("Volume.md"); h.focus(note); h.start(note);
  assert.equal(h.plugin.ctrl.active.volume, 0.37);
  if (mobile) h.body.querySelector(".action").emit("click");
  const button = h.body.querySelector(".pp-np-volume"); button.emit("click");
  const panel = h.body.querySelector(".pp-volume");
  assert.equal(panel.getAttribute("popover"), "auto");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  const slider = panel.querySelector("input");
  assert.equal(slider.getAttribute("type"), "range");
  assert.equal(slider.value, "37");
  slider.value = "0"; slider.emit("input");
  assert.equal(h.plugin.ctrl.active.volume, 0);
  assert.equal(slider.getAttribute("aria-valuetext"), "Muted");
  slider.value = "64"; slider.emit("input");
  h.plugin.ctrl.setDetune(25);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.plugin.savedData.volume, 0.64);
  assert.equal(h.plugin.savedData.detunes["app://vault/song.mp3"], 25);
  assert.equal(h.plugin.savedData.unrelated, "preserved");
  const saved = h.plugin.savedData;
  panel.emit("toggle", {newState: "closed"});
  assert.equal(button.getAttribute("aria-expanded"), "false");
  button.emit("click");
  h.plugin.onunload();
  assert.equal(h.body.querySelector(".pp-volume"), null);
  const restored = setup(mobile, saved);
  await Promise.resolve();
  restored.plugin.ctrl.loadAndPlay("app://vault/new.mp3", "New.md");
  assert.equal(restored.plugin.ctrl.active.volume, 0.64);
  assert.equal(restored.plugin.ctrl.detune, 0);
 });
}

test("volume changes before settings load win and apply to reused and new audio", async () => {
 let resolve;
 const h = setup(false, new Promise(done => { resolve = done; })), ctrl = h.plugin.ctrl;
 ctrl.loadAndPlay("app://vault/a.mp3", "A.md");
 const first = ctrl.active;
 ctrl.setVolume(0.24);
 resolve({volume: 0.9, unrelated: true});
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(ctrl.playbackVolume, 0.24);
 assert.equal(h.plugin.savedData.volume, 0.24);
 ctrl.loadAndPlay("app://vault/b.mp3", "B.md");
 assert.equal(ctrl.active.volume, 0.24);
 ctrl.setVolume(2);
 assert.equal(first.volume, 1); assert.equal(ctrl.active.volume, 1);
 ctrl.setVolume(-1);
 assert.equal(first.volume, 0); assert.equal(ctrl.active.volume, 0);
 ctrl.setVolume(NaN);
 assert.equal(ctrl.playbackVolume, 0);
});


test("volume popovers close when their player surface is removed", () => {
 const h = setup(), ctrl = h.plugin.ctrl;
 ctrl.loadAndPlay("app://vault/a.mp3", "A.md");
 const el = h.body.createDiv(), surface = h.queueSurface(el);
 el.querySelector(".pp-np-volume").emit("click");
 assert.ok(h.body.querySelector(".pp-volume"));
 surface.destroy();
 assert.equal(h.body.querySelector(".pp-volume"), null);
});
