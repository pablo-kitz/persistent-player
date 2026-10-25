# Persistent Player

Persistent Player keeps an audio embed playing when you scroll it out of view or open another note. Play an audio file in a note, then keep reading, editing, or navigating: the sound continues and a compact player follows the active Markdown view. The position is remembered per source note while the plugin is running.

No network requests, no telemetry. Everything runs locally inside the vault.

## Usage

Play any embedded audio file as you normally would. Instead of the inline embed, Persistent Player takes over playback with a now-playing bar at the top of the view:

- **Play or pause** the currently loaded audio, from any open note.
- **Click the source note's name** to return to the note where playback started.
- **Skip back or forward 5 seconds** for quick re-listening.
- **Drag the progress track** to seek anywhere in the file.
- **Click the speed label** to cycle through 0.5x, 0.75x, 1x, 1.25x, 1.5x, and 2x.
- **Close** to stop playback and release the note's audio.

Scrolling, switching notes, opening a note with another audio embed, or closing the source tab does not interrupt playback. Only explicitly playing another embed switches the audio. While playing, a speaker indicator marks open tabs for the source note; it disappears when playback pauses or ends. The indicator is omitted on surfaces without a tab header.

The controls follow the active Markdown view and remain available while paused. Focusing a non-Markdown view hides the controls without stopping the audio; the commands still work. Playing an embed again reuses that source note's loaded position if the audio file has not changed.

Video embeds are left untouched and play natively.

### Commands

The following commands are available from the command palette. Bind your own hotkeys in **Settings -> Hotkeys**:

- Play or pause
- Skip back 5 seconds
- Skip forward 5 seconds
- Skip back 15 seconds
- Skip forward 15 seconds

## Build

```bash
npm install
npm run build
```

The build runs TypeScript and Obsidian's official ESLint rules before producing `main.js`.

Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/persistent-player/`, then enable Persistent Player in Obsidian.

## Development

The source keeps `obsidian` external during the esbuild bundle. The optional speaker badge uses Obsidian's internal tab-header element because there is no public tab-badge API; playback does not depend on it. Run `npm install`, then `npm run dev` to rebuild on change. `npm run check` runs the regression tests, the linter, the type checker, and a production build.

## License

MIT
