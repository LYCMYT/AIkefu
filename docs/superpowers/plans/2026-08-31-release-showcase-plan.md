# AIkefu Demo Release and Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn commit `bd177d7` into a reproducible portfolio release with a verified three-minute demo video, a clear GitHub landing page, deployable container instructions, and truthful resume copy.

**Architecture:** Keep the product runtime unchanged. Store reproducible scripts and documentation in Git, keep generated video files out of source history, and distribute the final MP4 as a GitHub Release asset. Reuse the existing Docker Compose and GHCR workflows for deployment rather than introducing another hosting stack.

**Tech Stack:** pnpm workspace, Playwright, FFmpeg/FFprobe, PowerShell speech synthesis, Docker Compose, GitHub Actions and GitHub Releases.

**Spec:** `docs/showcase-plan/05_SHOWCASE_SCRIPT_3MIN.md`, `docs/DEPLOYMENT.md`, and the release roadmap approved in the 2026-08-31 Codex task.

## Global Constraints

- Do not change application business logic, prompts, evals, seed data, or runtime contracts.
- Do not commit `.env`, API keys, tokens, cookies, database data, MinIO objects, generated videos, raw recordings, or review exports.
- Preserve the truthful MockDouyin, synthetic-data, offline-provider, and no-production-SLA boundaries.
- GitHub Pages is not presented as a full-stack deployment target.
- A public deployment remains blocked until the owner provides a host/domain and accepts the associated cost and access-control decisions.

---

### Task 1: Release branch and documentation contract

**Files:**
- Create: `docs/RELEASE_V1.0.0_DEMO.md`
- Create: `docs/PORTFOLIO_RESUME_COPY.md`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: verified commit `bd177d7`, GitHub Actions run results, existing screenshots under `artifacts/showcase/` and `artifacts/ui/final/`.
- Produces: a landing page and release notes that link to tag `v1.0.0-demo` and the release video asset without claiming public deployment.

- [ ] **Step 1: Add a release-document hygiene assertion**

Extend `scripts/release-hygiene.test.mjs` to require the release notes and resume copy, verify the README points to `v1.0.0-demo`, and reject localhost URLs as a public demo link.

- [ ] **Step 2: Run the hygiene test and confirm the new assertions fail**

Run: `node --test scripts/release-hygiene.test.mjs`

Expected: FAIL because the new release documents and README links do not exist yet.

- [ ] **Step 3: Write the release notes, portfolio copy, README landing section, and generated-artifact ignores**

Document exact tested capabilities, the demo boundaries, local startup, the release video URL, CI links, deployment choices, and resume/interview wording. Ignore `artifacts/demo/` and `.review-export/`, but keep `scripts/record-demo.mjs` eligible for review and commit.

- [ ] **Step 4: Re-run the hygiene test**

Run: `node --test scripts/release-hygiene.test.mjs`

Expected: PASS.

### Task 2: Reproducible narrated demo

**Files:**
- Modify: `scripts/record-demo.mjs`
- Create: `scripts/generate-demo-voiceover.ps1`
- Create: `scripts/build-demo-video.ps1`
- Modify: `package.json`

**Interfaces:**
- Consumes: `http://127.0.0.1:5173`, existing `/showcase`/workbench/admin/scenario routes, FFmpeg and a local Chinese SAPI voice.
- Produces: ignored local artifacts `artifacts/demo/aikefu-3min-demo-source.webm`, `aikefu-3min-demo-voiceover.wav`, and `aikefu-3min-demo.mp4`.

- [ ] **Step 1: Add deterministic validation to the video build script**

The build must reject missing inputs, non-180-second output (tolerance 0.2 seconds), non-1440x900 output, missing H.264 video, or missing AAC audio.

- [ ] **Step 2: Generate aligned Mandarin narration**

Generate local speech segments for the eight existing timeline chapters and mix them at fixed offsets. Do not call an external TTS service or transmit project data.

- [ ] **Step 3: Build MP4 and cover image**

Trim the source to 180 seconds, encode H.264/AAC, mix narration without changing the recorded UI, and generate a cover frame.

- [ ] **Step 4: Verify media metadata and representative frames**

Run: `pnpm demo:build`

Expected: exit 0, duration 180 seconds, 1440x900 H.264 video and AAC mono/stereo audio.

### Task 3: Deployment handoff

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Create: `docs/PUBLIC_DEMO_CHECKLIST.md`

**Interfaces:**
- Consumes: `docker-compose.prod.yml`, GHCR workflow output, `.env.production.example`.
- Produces: a provider-neutral VPS checklist covering DNS, TLS, secrets, backups, access limits, smoke tests, upgrade and rollback.

- [ ] **Step 1: Document the two supported deployment paths**

Path A builds from source with Compose. Path B pulls tagged GHCR images after `v1.0.0-demo` is published. Both require a Linux host and HTTPS reverse proxy; neither claims GitHub Pages can host the backend.

- [ ] **Step 2: Add a preflight and post-deploy checklist**

Include secret rotation, outbound AI limits, CORS origin, migrations, health checks, WebSocket validation, backups and rollback.

- [ ] **Step 3: Validate Compose and documentation links**

Run: `docker compose --env-file .env.production.example -f docker-compose.prod.yml config --quiet`

Expected: PASS with placeholder values used only for configuration rendering.

### Task 4: Quality and security gates

**Files:**
- Test only; no additional production files.

**Interfaces:**
- Consumes: the complete release branch.
- Produces: fresh pass/fail evidence before commit, tag, push and release creation.

- [ ] **Step 1: Run secret scan and diff hygiene**

Run: `pnpm security:secrets` and `git diff --check`.

- [ ] **Step 2: Run typecheck, unit tests and production build**

Run: `pnpm typecheck`, `pnpm test:unit`, and `pnpm build`.

- [ ] **Step 3: Run integration and browser gates against real local infrastructure**

Run integration with `RUN_REAL_INFRA_INTEGRATION=1` and Playwright with `RUN_REAL_INFRA_E2E=1` against `http://127.0.0.1:5173`.

- [ ] **Step 4: Verify media and repository boundary**

Confirm the final MP4 is exactly 180 seconds with audio, and confirm no generated video, `.env`, review export, key or token is staged.

### Task 5: Publish release

**Files:**
- Git history and GitHub release metadata only.

**Interfaces:**
- Consumes: green Task 4 evidence and `artifacts/demo/aikefu-3min-demo.mp4`.
- Produces: merged `main`, annotated tag `v1.0.0-demo`, GitHub Release notes, release video asset, and passing GitHub Actions.

- [ ] **Step 1: Commit and push the release branch**

Commit only reviewed source scripts and documentation. Do not add ignored generated artifacts.

- [ ] **Step 2: Merge to main and verify the merged tree**

Fast-forward merge after local gates, run the release hygiene test again, and push `main`.

- [ ] **Step 3: Create and push annotated tag**

Create `v1.0.0-demo` at the verified merged commit and push it to origin.

- [ ] **Step 4: Publish GitHub Release with video asset**

Use `docs/RELEASE_V1.0.0_DEMO.md` as release notes and upload only `aikefu-3min-demo.mp4`. Because publishing and uploading are external side effects, obtain action-time confirmation immediately before the final GitHub publish operation.

- [ ] **Step 5: Verify release and Actions**

Confirm the release page, downloadable video, `main` ref, tag ref, CI and Container Images workflows all point to the same commit.
