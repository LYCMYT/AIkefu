# AIkefu Showcase 3-Minute Video Implementation Plan

> Execute continuously on `codex/showcase-video-v2`. Do not push. Do not change core reply, Seed, Prompt, Eval, or business semantics.

**Goal:** Replace the obsolete product-tour recording with a truthful 2:50–3:05 Chinese Showcase video built from the current four real scenarios, online neural narration, subtitles, trace evidence, and a clean closing frame.

**Architecture:** Reuse `/showcase` and its isolated SEEDED Workspace. Add a query-gated recording presentation layer (`?recording=1`) and a deterministic Playwright recording driver. Generate Mandarin audio with Microsoft Edge online TTS, then assemble and verify H.264/AAC deliverables with ffmpeg. Existing product behavior remains unchanged outside recording mode.

**Tech Stack:** React, TypeScript, Vitest, Playwright, PowerShell, ffmpeg/ffprobe, edge-tts.

---

## Task 1: Lock the recording contract with tests

- Add focused tests for recording query parsing, compact trace stages, closing mode, and the recording-only shell.
- Add Playwright assertions for 1920×1080 and 1440×900 recording layouts, no console diagnostics, no global overflow, real scenario completion, redacted trace, and closing frame.
- Run the tests first and confirm they fail for the missing recording behavior.

## Task 2: Implement the recording presentation layer

- Add a small recording view model for query state, scene progress, and an eight-stage trace projection.
- Make `Application`/`AppShell` hide non-recording chrome only for `/showcase?recording=1`.
- Make `ShowcasePage` compact the hero, capability copy, controls, and Live Test surface while preserving real APIs, reset, scene tabs, product context, and evidence.
- Add a truthful final frame for `closing=1` and a recording-only trace panel with details collapsed by default.

## Task 3: Produce recording artifacts and editorial copy

- Add the approved plan under `docs/video/`.
- Create `artifacts/recording/SHOT_LIST.md`, `VOICEOVER_CN.md`, `SUBTITLES_CN.srt`, and `RECORDING_CHECKLIST.md`.
- Capture the required overview, four scene, trace, and closing screenshots from the latest running application.

## Task 4: Build the deterministic Showcase recorder

- Add `scripts/record-showcase.mjs` and `pnpm showcase:record`.
- Record 1920×1080, 30 fps, isolated Showcase Workspace, real API/WS scenarios, per-scene source clips, trace, and closing frame.
- Fail on page errors, console warnings, missing proof, missing reply visibility, overflow, skipped scenes, or empty clips.

## Task 5: Generate online Mandarin narration and subtitles

- Add a pinned edge-tts generator using `zh-CN-XiaoxiaoNeural` and an initially faster `+20%` rate.
- Keep voice credentials unnecessary and generated environment/artifacts outside tracked source.
- Verify every segment duration against the edit timeline and adjust rate/text only when needed for the 3-minute cut.

## Task 6: Assemble and technically verify final media

- Add an ffmpeg build script that creates voiced and no-voice 1920×1080 H.264 videos, AAC audio, faststart metadata, thumbnail, and embedded/external subtitles.
- Verify duration, frame size, frame rate, codecs, audio presence, black-frame risk, and non-empty outputs with ffprobe.
- Write `artifacts/recording/RECORDING_EVIDENCE.md` with commands, timings, checksums, and truthful boundaries.

## Task 7: Run release gates and prepare replacement

- Run focused tests, full typecheck/unit/integration/build, real Showcase Playwright, secret scan, and media probes.
- Inspect the final MP4 and thumbnail visually.
- Do not commit or push. After all evidence is green, request the user's final action-time confirmation to replace the existing GitHub Release asset; preserve the canonical public asset name so existing links keep working.
