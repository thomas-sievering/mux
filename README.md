# mux

Minimal terminal YouTube player for long mixes, ambience, and focus music.

`mux` is intentionally tiny:
- type a query
- it finds a good long YouTube result
- plays audio via `mpv`
- lets you skip, pause, stop, favorite, and replay from the terminal
- strips emoji from displayed YouTube titles

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
- `s` stops playback and returns to the prompt

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
bun run install:global
```

The installer will:
- build `mux`
- register/link it with Bun
- check whether `mux` is already available on your `PATH`
- print Bun's global bin directory if it is not

Or use the helper scripts:

```powershell
./scripts/install-global.ps1
```

```bash
sh ./scripts/install-global.sh
```

Then you can run:

```bash
mux
```

If `mux` is not found, open a new terminal first. If it still is not found, add the directory printed by the installer (`bun pm bin`) to your `PATH`.

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

### Help

```bash
mux --help
mux --version
```

Prompt commands:

- search keywords
- YouTube URL
- `last`
- `recent`
- `shuffle`
- `fav` / `favs` / `favorites`
- `q`

CLI flags:

- `-h` / `--help`
- `-v` / `--version`

Environment variables:

- `MUX_COOKIES_FROM_BROWSER=<browser>` to pass `--cookies-from-browser` to `yt-dlp`
- `MUX_COOKIES=<file>` to pass a cookies file to `yt-dlp`

Interactive settings commands:

- `settings`
- `cookies chrome`
- `cookies edge`
- `cookies firefox`
- `cookies brave`
- `cookies file <path>`
- `cookies off`

### Direct query

```bash
mux harry potter study
mux succession focus music
```

### Direct URL

```bash
mux https://www.youtube.com/watch?v=...
```

### YouTube bot-check / cookies

If YouTube starts asking `yt-dlp` to sign in, `mux` now tries detected local browser cookie stores automatically first. If that does not work, it opens settings and shows detected cookie stores for Chrome, Edge, Firefox, and Brave. You can pick one by number, or type a command manually:

```text
mux> settings
settings> 1
settings> cookies edge
```

Or run `mux` with cookies from the shell:

```powershell
$env:MUX_COOKIES_FROM_BROWSER="edge"
mux
```

```bash
MUX_COOKIES_FROM_BROWSER=chrome mux
```

Or use an exported cookies file:

```bash
MUX_COOKIES=/path/to/cookies.txt mux
```

## Playback keys

Shown in the app as:

```text
[p]ause  [n]ext  [s]top  [f]av  [l]oop  [o]pen  [q]uit  [1-9] vol
```

Meaning:

- `p` pause / resume
- `n` skip to next result
- `s` stop playback and return to the `mux>` prompt
- `f` add current track to favorites
- `l` toggle loop for the current track
- `o` open the current YouTube link in your browser
- `q` quit `mux`
- `1-9` set volume from 10% to 90% and remember it for later sessions

Typed commands also work while playing:
- `pause`
- `skip`
- `stop`
- `fav`
- `loop`
- `open`
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
