# mux

Minimal terminal YouTube player for long mixes, ambience, and focus music.

`mux` is intentionally tiny:
- type a query
- it finds a good long YouTube result
- plays audio via `mpv`
- lets you skip, pause, stop, favorite, and replay from the terminal

No browser required.

## Features

- interactive prompt: `mux`
- direct query: `mux harry potter study`
- direct YouTube URL support
- automatic query expansion for better results
  - `harry potter study` becomes roughly `harry potter study ambience music`
- prefers long videos
- random pick from top results
- next/skip through the remaining results
- search spinner while loading
- minimal single-line playback status
- favorites support
- recent history and weighted shuffle

## Requirements

Install these first and make sure they are in your `PATH`:

- [Bun](https://bun.sh/)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
- [`mpv`](https://mpv.io/)

## Install

```bash
bun install
bun run build
```

Optional global link:

```bash
bun link
```

Then you can run:

```bash
mux
```

## Development

```bash
bun run dev
```

## Build

```bash
bun run build
```

## Tests

```bash
bun test
```

## Usage

### Interactive

```bash
mux
```

Prompt commands:

- search keywords
- YouTube URL
- `last`
- `recent`
- `shuffle`
- `fav` / `favs` / `favorites`
- `q`

### Direct query

```bash
mux harry potter study
mux succession focus music
```

### Direct URL

```bash
mux https://www.youtube.com/watch?v=...
```

## Playback keys

Shown in the app as:

```text
[p]ause  [n]ext  [s]top  [f]av  [q]uit  [1-9] vol
```

Meaning:

- `p` pause / resume
- `n` skip to next result
- `s` stop playback
- `f` add current track to favorites
- `q` quit
- `1-9` set volume from 10% to 90%

Typed commands also work while playing:
- `pause`
- `skip`
- `stop`
- `fav`
- `quit`

## Favorites

Press `f` during playback to save the current track.

To play from favorites later:

```bash
mux
```

then type:

```text
fav
```

and choose one from the list.

## Data files

`mux` stores state in:

- `~/.mux/history.json`
- `~/.mux/favorites.json`

## How selection works

When you enter search keywords, `mux`:

1. expands the query a little for better results
2. asks `yt-dlp` for the top YouTube matches
3. prefers videos that are at least 20 minutes long
4. randomly picks from the top preferred matches
5. queues the remaining results so `n` can skip forward

## Notes

- Playback is handled by `mpv`
- Search and metadata come from `yt-dlp`
- The terminal visualizer is intentionally minimal
- This project is mainly for personal/local use
