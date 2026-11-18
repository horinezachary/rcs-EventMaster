# Event Master

A [Rack Control Surface](https://github.horinetech.com/rcs-releases/) module for Barco Event Master
processors (E2, S3-4K, EX). It puts the processor's presets on the Stream Deck: press one to recall it
to preview, then TAKE. The screen shows what is on preview and program, and which source every screen
and aux destination shows, layer by layer.

- **Presets**: every preset by preset number. Tap to recall to preview. Green is on preview, red on
  program. TAKE and CUT in the header.
- **Outputs**: each screen destination with its layers and background on program (PGM) and preview
  (PVW), and each aux with its source. PVW DIFFERS marks a destination whose preview is not what is live.
- **Screens**: each screen destination drawn to scale, preview beside program. The background fills the
  canvas and every layer's source sits where its window is, bottom layer first, so upper layers cover lower
  ones. Dashed lines show how the canvas is cut into the processor's outputs. A source keeps the same
  colour on every screen.
- **Sources**: inputs with format and signal status (OK, no sync, format mismatch…), backgrounds and other
  sources.
- **Setup**: the processor address, Allow controls, the operator (multi-operator mode), and every frame
  of the system with its software, address, power supplies and cards.

The web view has the same pages. TAKE and CUT ask for a confirmation there; the super-operator password
is set on its Setup page.

## Multi-frame systems

An Event Master system can link up to four frames under one host. Point the module at the host frame: the
JSON-RPC API answers there for the whole system, so presets, sources and destinations already span every
frame. Setup lists each frame the host reports (`getFrameSettings`) with its model, software, IP, power
supplies (`powerStatus`, per frame) and cards, and marks the host. The module warns, in the header and
on every web page, when:

- a frame it has seen since starting is no longer in the system,
- the frames run different software,
- a power supply has no power cable or no DC output,
- a card's status reads as a fault (failed, error, mismatch and the like).

The manual shows a single frame as an object under `FrameCollection.Frame`; with several frames the
module reads an array there (or an array of collections). That shape has only been tried against the
simulator.

## Stream Deck

| Key | Does |
| --- | --- |
| 1-10 | Presets, by preset number. Press: recall to preview. Green on preview, red on program |
| 11 | More presets (with more than 10) |
| 12 / 13 | What is on preview / program. Press for the Outputs page |
| 14 | CUT: hold for 0.7 s |
| 15 | TAKE: transition every armed destination with its own transition time |

On a larger deck (an XL, 8×4, or a Stream Deck + XL, 9×4) presets fill every row but the bottom one and the
middle of the bottom row; the bottom row starts with the page key and ends with preview, program, CUT and
TAKE. An XL shows 27 presets a page. This needs controller 0.21.0 or later; older controllers show the
15-key layout.

## Which preset is on preview and program

The Event Master API has no way to ask which preset is on preview or program. The module remembers the
preset it recalled itself, and which one it took, and shows those. It reads what every destination
shows once a second: when someone changes preview or program from elsewhere (the E2's own console, Event
Master Toolset, another controller), the marker goes to — while the Outputs page keeps showing what is
really there.

## The processor is the source of truth

Everything shown is read from the processor and kept only in memory. State holds the preset page; config
holds the address, port, operator and the Allow controls switch (off by default), so named saves carry
exactly those, plus the super-operator password, which is a module secret: in named saves (sealed with
a passphrase in a download), never sent to a UI. Starting, restoring a save, resuming after a power cut and
reconnecting only read. Commands go out only when someone presses a preset key, TAKE or CUT (or a button in
the panel or web view), and only with Allow controls on.

## What it reads and sends

JSON-RPC 2.0 over HTTP POST to `http://<processor>:9999/` (Barco *JSON RPC for Event Master
processors*, v9.2).

| | Methods |
| --- | --- |
| Reads, every second | `listContent` for every screen destination, `listAuxContent` for every aux |
| Reads, every 5 seconds | `getFrameSettings`, `powerStatus`, `listSources`, `listPresets`, `listDestinations` |
| Preset key | `activatePreset {id, type: 0}` (to preview) |
| TAKE | `allTrans {}` |
| CUT | `cut {}` |

With an operator chosen in Setup the commands carry `operatorId`; with a super-operator password they carry
`password` instead. The API has no login of its own.

Not in the API, so not in the module: video thumbnails of the inputs, outputs or multiviewer, and which
preset is active (see above). Caveats: the background on a screen is named from the background sources
(`listSources` SrcType 1), which the manual does not spell out; a layer's `Window` comes as two entries,
and like `BGLyr` the Screens view takes id 0 as program and id 1 as preview, also not in the manual; **commands have only been tried against
the simulator.** Ask before pointing a development build with Allow controls on at a show processor.

## Develop

Node.js 22 or later, and a checkout of the main `rack-control-surface` repo, which holds the SDK
until it is published to npm.

```sh
# next to this folder: git clone …/rack-control-surface && cd rack-control-surface && npm install && npm run build
npm install            # links the SDK from ../rack-control-surface when it is there
npm run link-sdk -- C:\src\rack-control-surface    # or point at a checkout somewhere else (or set RCS_REPO)
npm test               # client, parser and module tests against the simulator and the SDK's fake controller
npm run sim            # a simulated E2 on 127.0.0.1:9999: 13 presets, 3 screens, 3 aux, 12 inputs
npm run dev            # the rack simulator at http://127.0.0.1:5173/sim, web view at http://127.0.0.1:5174
```

Set the address to `127.0.0.1` in the module's Setup and turn on Allow controls. Make the simulator act
like a busy show with, for example, `curl 'http://127.0.0.1:9999/sim/recall?preset=3'` (another operator
recalls a preset), `curl 'http://127.0.0.1:9999/sim/source?id=2&video=4'` (an input loses sync) or
`curl 'http://127.0.0.1:9999/sim/silent?on=1'` (the processor stops answering). `npm run sim -- --password pw`
requires a super-operator password; `npm run sim -- --frames 3` simulates three linked frames, and
`curl 'http://127.0.0.1:9999/sim/frame?n=2&present=0'` drops frame 2 out of the system (see the top of
`src/sim/e2.ts` for power supply, card and software faults). `RCS_E2_POLL_MS` polls faster during development.

## Releasing

Every merge to `master` (the default branch) is a release (`.github/workflows/release.yml`), versioned from the PR title:
`feat:` is a minor bump, `!:` or `BREAKING CHANGE` a major one, anything else a patch; `[skip release]`
skips it. The workflow tests, stamps the version into `module.json`, packs, signs and publishes
`event-master-<version>.zip` and its `.sig` as a GitHub release here, where units find it through the
module index in [horinezachary/rcs-releases](https://github.com/horinezachary/rcs-releases).

It needs two Actions secrets:

- `RCS_SIGNING_KEY`: the module's private signing key, made with
  `node node_modules/@rcs/module-sdk/dist/pack-cli.js keygen`. Its public key is this module's entry in
  `index.json` in rcs-releases.
- `RCS_SOURCE_TOKEN`: a fine-grained token with Contents read-only on `rack-control-surface`, so the
  workflows can link the SDK from it. CI uses the tag in `package.json` `rcs.sdkRef`.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | The module backend: keys, views, config, the password secret and the messages its UIs send |
| `src/processor.ts` | Polls the processor, keeps what it read in memory, tracks the recalled presets, sends commands |
| `src/e2.ts` | The JSON-RPC call and the parsers for the processor's answers |
| `src/sim/e2.ts`, `src/sim-cli.ts` | The simulated processor |
| `ui/index.html` | The panel UI: Presets, Outputs, Sources, Setup |
| `web/index.html` | The web view's pages |
| `scripts/link-sdk.mjs` | Links `@rcs/*` from a main repo checkout |
