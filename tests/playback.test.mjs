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
function setup(mobile = false) {
	const mediaListeners = new Map();
	class Element {
		constructor(tag = "div", cls = "") {
			this.tag = tag;
			this.cls = cls;
			this.children = [];
			this.parentElement = null;
			this.attributes = {};
			this.style = {};
			this.listeners = new Map();
			this.textContent = "";
            this.classList = { add: cls => { this.cls += ` ${cls}`; } };
		}
		replaceChildren() { for (const child of [...this.children]) child.remove(); }
        get firstChild() { return this.children[0] ?? null; }
		hasClass(cls) { return this.cls.split(" ").includes(cls); }
		matches(selector) { return selector.startsWith(".") ? this.hasClass(selector.slice(1)) : this.tag === selector; }
		createEl(tag, options = {}) {
			const child = tag === "audio" ? new Audio() : new Element(tag);
			child.cls = typeof options === "string" ? options : options.cls ?? "";
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
		setAttribute(name, value) { this.attributes[name] = value; }
		removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; }
		addEventListener(name, cb) {
			if (!this.listeners.has(name)) this.listeners.set(name, new Set());
			this.listeners.get(name).add(cb);
		}
		removeEventListener(name, cb) { this.listeners.get(name)?.delete(cb); }
		emit(name) { for (const cb of this.listeners.get(name) ?? []) cb({ target: this }); }
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
		constructor(app) { this.app = app; this.cleanups = []; this.commands = new Map(); }
		registerDomEvent(target, event, cb) {
			target.addEventListener(event, cb);
			this.cleanups.push(() => target.removeEventListener(event, cb));
		}
		registerEvent(cleanup) { this.cleanups.push(cleanup); }
		addCommand(command) { this.commands.set(command.id, command); }
	}
	const body = new Element("body");
	const workspaceEl = body.createDiv("workspace");
	const workspaceEvents = new Map();
	const leaves = [];
	let active = null;
	const workspace = {
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
		body,
		addEventListener(event, cb) {
			if (!mediaListeners.has(event)) mediaListeners.set(event, new Set());
			mediaListeners.get(event).add(cb);
		},
		removeEventListener(event, cb) { mediaListeners.get(event)?.delete(cb); },
	};
	const module = { exports: {} };
	runInNewContext(code, {
		module, exports: module.exports, document, HTMLAudioElement: Audio,
		createDiv: cls => new Element("div", cls),
		require: () => ({ MarkdownView, ItemView: MarkdownView, Platform: {isMobile: mobile}, Modal, Plugin, setIcon: (el, icon) => { el.icon = icon; } }),
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
	function focus(leaf) { active = leaf; emit("active-leaf-change"); }
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
	return { body, workspace, plugin, leaves, note, focus, emit, embed, start, command };
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
	const controls = source.parentElement.children;
	assert.equal(controls[controls.indexOf(source) - 1].cls, "clickable-icon pp-np-rate");
	assert.equal(controls[controls.indexOf(source) + 1].cls, "clickable-icon pp-np-close");
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
	assert.equal(h.body.querySelector(".pp-np-source").textContent, "Second");
	assert.equal(h.start(a), first);
	assert.equal(first.currentTime, 19);
	assert.equal(second.paused, true);
	assert.equal(h.body.querySelector(".pp-np-source").textContent, "First");
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


test("previous and next follow source-note order and stop at playlist boundaries", () => {
 const h = setup(); const a = h.note("Playlist.md"); h.focus(a);
 const first = h.embed(a, "app://vault/first.mp3");
 h.embed(a, "app://vault/second.mp3");
 h.embed(a, "app://vault/third.mp3");
 void first.play();
 const buttons = () => h.body.querySelectorAll(".pp-np-track-button");
 assert.equal(buttons()[0].disabled, true);
 buttons()[1].emit("click");
 const audio = h.body.querySelector(".pp-pooled");
 assert.equal(audio.src, "app://vault/second.mp3");
 const other = h.note("Other.md"); h.focus(other);
 buttons()[1].emit("click");
 assert.equal(audio.src, "app://vault/third.mp3");
 assert.equal(buttons()[1].disabled, true);
 buttons()[1].emit("click");
 assert.equal(audio.src, "app://vault/third.mp3");
 buttons()[0].emit("click");
 assert.equal(audio.src, "app://vault/second.mp3");
 assert.equal(first.src, "app://vault/first.mp3");
});

test("mobile exposes one music action and opens the album-art player", () => {
 const h = setup(true); const a = h.note("Song.md"); h.focus(a); h.start(a);
 let actions = h.body.querySelectorAll(".action");
 assert.equal(actions.length, 1); assert.equal(actions[0].icon, "music");
 actions[0].emit("click");
 assert.ok(h.body.querySelector(".pp-player-card"));
 assert.equal(h.body.querySelector(".pp-album-art").icon, "music");
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
 const context = { module: {exports: {}}, require: () => ({Plugin: class {}}), FileReader, Image,
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
  const bar = h.body.querySelector(".pp-now-playing");
  const controls = bar.children.filter(el => el.hasClass("clickable-icon"));
  assert.deepEqual(controls.map(el => el.attributes["aria-label"]), [
   "Previous audio", "Skip back 5 seconds", "Play or pause", "Skip forward 5 seconds", "Next audio",
  ]);
 });
}
