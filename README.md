# video-demo-generator

Learns a product from its help center, drives its demo environment, and records
narrated, subtitled demo videos of any feature you ask for.

```bash
vdg learn https://help.example.com --product example
vdg connect https://demo.example.com --product example --profile demo
vdg record "approve a time off request" --product example --profile demo
# → workspace/demos/approve-a-time-off-request/out/demo.mp4 + demo.srt
```

## How it works

The expensive, non-deterministic work happens **once per feature** and is frozen
into a file. Re-recording, re-voicing, or fixing a step afterwards is cheap,
reproducible, and hand-editable.

```
help center ──▶ features.json ──▶ storyboard ──▶ [scout drives the real app]
                                                          │
                                                    steps.json  ◀── you can edit this
                                                          │
                                        ┌─────────────────┴─────────────────┐
                                        ▼                                   ▼
                                  narration + TTS                  deterministic replay
                                        └─────────────────┬─────────────────┘
                                                          ▼
                                                 demo.mp4 + demo.srt
```

Seven stages, each reading and writing one artifact under `workspace/`, each
independently runnable:

| Stage | What it does | Writes |
|---|---|---|
| `learn` | Crawls the help center, extracts articles, distills a feature catalog | `knowledge/<product>/` |
| `connect` | Signs in to the demo environment, saves the session, maps the navigation | `profiles/<profile>/` |
| plan | Matches your request to a feature and drafts a shot list from the docs | `demos/<slug>/storyboard.json` |
| scout | **Drives the real product** and records the steps that actually worked | `demos/<slug>/steps.json` |
| narrate | Writes the voiceover and renders it to audio with word timings | `demos/<slug>/narration.json` |
| record | Replays the script in front of a camera, with a synthetic cursor | `demos/<slug>/timeline.json` |
| compose | Muxes video, voice and subtitles | `demos/<slug>/out/` |

Two ideas carry most of the weight:

**The documentation is a hypothesis; the running product is the truth.** The
storyboard is drafted from the docs, then the scout performs the feature itself
and records only the steps that worked. Where the two disagree it reports the
divergence. The resulting script is then verified by replaying it from a clean
session before anything is recorded.

**Locator policy lives in code, not in the model.** The scout sees a snapshot of
interactive elements with opaque refs and picks which one to act on; the durable
locator — role, then label, then placeholder, then test id, then text, and only
then CSS — is derived from that same snapshot by `deriveLocator`. The model
chooses *what* to click. It never chooses how that element will be found
tomorrow.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
brew install ffmpeg
cp .env.example .env    # then fill in the keys
pnpm vdg doctor         # tells you exactly what is still missing
```

| Variable | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | `learn`, the storyboard, the scout, narration polish |
| `ELEVENLABS_API_KEY` | voiceover (or set `VDG_TTS_PROVIDER=openai` / `say`, or use `--no-voice`) |
| `VDG_DEMO_USERNAME` / `VDG_DEMO_PASSWORD` | `connect` without `--manual` |
| `VDG_LANGUAGE` | language the narration is written in (default `English`) |

The narration language is independent of the product's own language. A demo
tenant rendered in Spanish still gets English narration by default, with UI
labels quoted as they appear on screen — "click **Añadir ausencia**" inside an
English sentence. Set `VDG_LANGUAGE=Spanish` to narrate in Spanish instead.

## Commands

```
vdg doctor
vdg learn <docs-root-url> --product <slug> [--max-pages 500] [--include <regex>]
          [--depth <n>] [--refresh] [--crawl-only]
vdg features --product <slug> [--search "time off"] [--verbose]
vdg connect <app-url> --product <slug> --profile <name> [--manual] [--deep]
vdg record "<request>" --product <slug> --profile <name>
           [--feature <id>] [--steps <path>] [--no-voice] [--burn-subs]
           [--raw-narration] [--headed] [--dry-run]
vdg replay <slug> [--verify] [--revoice] [--no-voice] [--burn-subs] [--headed]
```

Notes on a few of these:

- `learn` uses the sitemap when there is one. Two flags narrow that down:
  `--include <regex>` keeps only matching URLs, and `--depth <n>` ignores the
  sitemap and instead follows links `n` hops from the root — `--depth 1` means
  "this page and what it links to". They compose:

  ```bash
  vdg learn https://help.example.com/en_US/time-tracking-absences \
    --product example --depth 1 \
    --include "/en_US/(time-tracking|absences-approvals|time-off-settings)/"
  ```

  Depth mode discovers links **in a browser and takes only the visible ones**.
  Some help-center templates ship the whole site index in every category page
  and scope it with CSS — one real category page carried 720 links of which 47
  were on screen — so following raw hrefs there crawls the entire site.
- `--crawl-only` costs nothing and writes the extracted Markdown to
  `workspace/knowledge/<product>/pages/`. Worth running first on an unfamiliar
  site, before paying for feature extraction.
- `connect --manual` opens a real window so you can clear SSO or 2FA by hand.
  The session is saved afterwards and reused by every later stage.
- `record --dry-run` matches the feature and prints the storyboard without
  touching the demo environment or spending anything on scouting.
- `replay <slug> --verify` re-runs a recorded script against the live product
  without recording. This is the regression check: it tells you when the product
  has drifted away from a demo you already shipped.
- `steps.json` is meant to be edited. Change a narration line, drop a step,
  reorder something, then `vdg replay <slug> --revoice`.

## Subtitles

Every video carries a soft `mov_text` subtitle track players can toggle, plus
`demo.srt` and `demo.vtt` beside it. With ElevenLabs the cue timings come from
real character-level alignment, so a cue changes exactly when the speaker
reaches that word; other providers estimate from word length.

`--burn-subs` additionally renders `demo-subtitled.mp4` with the text painted
into the picture. That needs an ffmpeg built with libass — Homebrew's default
build has none, and `vdg doctor` says so.

## Development

```bash
pnpm typecheck
pnpm test          # 35 tests; the integration suite starts its own server + browser
```

`fixtures/` holds a complete offline target: a static help center and a small
product with a login, a sidebar, a table and a modal dialog. The whole pipeline
can be exercised against them with no API keys and no network:

```bash
node fixtures/serve.mjs docs 4173 &
node fixtures/serve.mjs app  4174 &

# crawl the fake help center (feature extraction needs a key, so stop short)
pnpm vdg learn http://localhost:4173 --product acme --crawl-only

# sign in to the fake product and map it
VDG_DEMO_USERNAME=manager@acme.test VDG_DEMO_PASSWORD=demo1234 \
  pnpm vdg connect http://localhost:4174/login.html --product acme --profile demo --deep

# record a video from a checked-in script, skipping the scout
pnpm vdg record "approve a time off request" --product acme --profile demo \
  --steps fixtures/approve-time-off.steps.json --no-voice
```

That last command exercises replay, the synthetic cursor, video capture,
subtitle generation and the ffmpeg mux, and produces a real 1920x1080 MP4 in
`workspace/demos/approve-time-off/out/`.

### Two things worth knowing before editing

**`page.evaluate` bodies.** esbuild (which `tsx` runs) rewrites function-valued
locals into `__name(fn, "fn")` calls, and that helper does not exist in the
page. Every context is created through `src/browser.ts`, which installs a no-op
`__name` shim so evaluate bodies behave like ordinary TypeScript. Create
contexts through `newContext`, not `browser.newContext`.

**The top layer.** A modal `<dialog>` renders above any z-index, so the
synthetic cursor is opened as a popover and re-raised before each draw — see
`raise()` in `src/record/cursor.ts`. Without that the cursor vanishes the moment
a demo opens a dialog.

## Environment variables

Beyond the keys above: `VDG_MODEL`, `VDG_EFFORT`, `VDG_WORKSPACE`,
`VDG_VIDEO_WIDTH` / `VDG_VIDEO_HEIGHT`, `VDG_DEVICE_SCALE`, `VDG_WPM`,
`VDG_MAX_PAGES`, `VDG_CRAWL_CONCURRENCY`, `VDG_FFMPEG` / `VDG_FFPROBE`, and
`VDG_AV_OFFSET_MS` to shift the narration track if voice and picture drift.
