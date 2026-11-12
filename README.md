# Persistent Player

Persistent Player keeps an audio embed playing when you scroll it out of view or open another note. Play an audio file in a note, then keep reading, editing, or navigating: the sound continues and a compact player follows the active Markdown view. The position is remembered per source note while the plugin is running.

No network requests, no telemetry. Everything runs locally inside the vault.

## Usage

Play any embedded audio file as you normally would. Instead of the inline embed, Persistent Player takes over playback with a now-playing bar at the top of the view:

- **Play or pause** the currently loaded audio, from any open note. Press **Space** while focus is in the player to toggle playback; **Enter** activates the focused button.
- **Click the source note's name**, between the speed and close controls, to return to the note where playback started. The name is hidden while viewing that note.
- **Skip back or forward 5 seconds** for quick re-listening.
- **Drag the progress track** to seek anywhere in the file.
- **Click the speed label** to cycle through 0.5x, 0.75x, 1x, 1.25x, 1.5x, and 2x.
- **Open the volume control** for a slider from 0% (silent) to 100%. Volume applies immediately and is saved in your plugin configuration across sessions.
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

### Recording tuning

Open the speed control to adjust playback speed, semitones, and cents in one popover. Semitones (-12 to +12) and cents (-99 to +99) are saved automatically in the recording's embed display text in the source note:

```markdown
![[song.mp3|detune=-35]]
```

The `detune` parameter stores total cents. Existing display text is preserved, for example `![[song.mp3|My song detune=-35]]`. Markdown embeds use `![My song detune=-35](song.mp3)`. Positive raises pitch. Reset writes zero. Tuning travels with the note and stays inside the embed when Obsidian updates its link after a rename. Different notes can use different tuning; repeated embeds of the same recording within one note share the correction. Copying the embed includes its tuning. Older tuning comments remain readable and are converted to display text the next time you adjust tuning. Recordings without a resolvable note embed still use plugin data as a fallback.

Tuning changes tempo too, like tape speed. At nonzero tuning the speed control also affects pitch; use 1x for the specified correction.
