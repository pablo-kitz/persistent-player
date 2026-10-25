# Changelog

## 1.0.6

- Fix corrupted playback-speed menu labels with plain x suffixes.
- Replace the composite source-note icon with the built-in external-link icon.
- Restore tidy 14px desktop icons and compact interface text inside equal 28px buttons.


## 1.0.5

- Restore the desktop bar to 32px with equal 28px buttons.
- Fix the source-note icon and move it immediately before the close button.
- Position the metadata card below the player bar.
- Replace playback-speed cycling with a checked selection menu.
- Show playing/paused ownership status below native audio embeds with an Open player action.
- Keep embed status synchronized across track changes, note rerenders, and plugin cleanup.


## 1.0.4

- Refine desktop playback into one row with equal-sized controls and metadata or filename labels.
- Show artwork and recording details on title hover or keyboard focus.
- Show an accent source-note icon only when viewing another note.
- Remove the mobile player card background and add a labeled Stop action.
- Deduplicate audio embeds and exclude non-audio files from track navigation.
- Keep the player in the main workspace when a sidebar is focused.


## 1.0.3

- Keep playback running across notes and show the playing source tab.
- Use a single music action on mobile to open an album-art player.
- Add previous/next audio controls in source-note order, with square transport buttons.
- Integrate system media controls and normalize embedded artwork for iOS.


## 1.0.2

- Use `createSpan` for the time label instead of `createEl("span", ...)`.

## 1.0.1

- Use Obsidian's `createEl` and `createDiv` helpers instead of `document.createElement`.

## 1.0.0

- Initial release.
- Audio keeps playing when its embed is scrolled out of view.
- Remembers the playback position per note.
- Now-playing bar with play/pause, 5-second skip, draggable seek, and speed cycling.
