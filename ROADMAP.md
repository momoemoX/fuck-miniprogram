# Roadmap

This repository implements a pure-Web Mini Program runtime (`@fuck-miniprogram/engine`) and CLI (`@fuck-miniprogram/cli`).

## Layer 3 host interaction delivery (2026-11-22)

Verified against conformance suite `c33dec4`, without changing its expectations or driver:

| Layer | Executed result | Usage-weighted coverage |
| --- | --- | --- |
| Layer 1 semantics | 706 / 718; all 6 new parameter-error cases pass; no new failures | 30.6% |
| Layer 2 static visuals | 25 / 61 with default Chrome capture | 67.3% |
| Layer 3 real host interactions | **35 / 35**, up from 16 / 35 | **100%** |

The suite's three-dimensional overall usage coverage is **33.1%**. Layer 1 ran with core/http/socket enabled and driver disabled; strict optional Web contracts are separate and are not counted as passed. The visual score uses default Chrome capture and must not be compared directly to the earlier Display-P3 style snapshot below.

- `pnpm build && pnpm typecheck && pnpm test`: passed, **34 files / 405 tests**, including 25 new browser interaction scenarios.
- Media/files: real preview hit testing, both navigation directions, numeric/URL current, mixed video preview, virtual temporary paths, selected bytes to image info/preview, and actual downloads.
- Documents: PDF assets are included in CLI output; PDF.js renders real file content in a closable viewer, with worker and URL teardown and an Apache-2.0 notice.
- Location: coordinate selection is immediately interactive without waiting for permission; users can request geolocation explicitly, confirm/cancel a point, or view and close supplied location details. Host controls are mapped by public button text in `scripts/interactive-controls.json`.
- Feedback/pickers: masked input interception, physical DOM unmount, viewport-safe cancel controls, immediate selections, stable column linkage, and numeric time/date controls.
- Viewport/gestures: all 7 real scrolling, fixed-position, refresh, swiper and movable scenarios pass.

Reproduce all three layers with `node scripts/run-conformance.mjs --interactive --visual`. Use `--interactive-only` or `--interactive-ids <comma-separated ids>` for focused runs; `--interactive-out`, `--interactive-screenshots`, `--interactive-controls`, and `--work-dir` select reports, host labels and an isolated temporary build directory.

The following conformance snapshot records the preceding style pass.

## Engineering Principles

1. **Specification-driven**: implement behavior from public documentation and black-box conformance tests ([`fuck-miniprogram-conformance-tests`](https://github.com/momoemoX/fuck-miniprogram-conformance-tests)).
2. **Build before testing bundles**: run `pnpm build && pnpm typecheck && pnpm test` after modifying `packages/engine/src/`.
3. **Real implementations only**: do not add no-op API stubs that silently return `{ errMsg: '*:ok' }`.

## Conformance Status

Latest local verification against the 3.7.12 suite (re-run 2026-11-27):
- **Automated suite**: **706 / 718** passed
  - `behavior`: **682 / 693**
  - `shape`: **21 / 21**
  - `quirk`: **3 / 4**
- **Component host boxes**: **47 / 48** passed; the remaining input height differs by 0.01px after browser layout quantization.
- **Visual references**: **39 / 61** matched, versus **29 / 61** before these style changes under the same Display-P3 capture. The original reference images, comparator, and tolerances were unchanged. Default-profile capture of that same old build scored 16/61; profile-only improvements are excluded from the style delta.
- **Unit & integration tests**: **34 / 34** files, **407 / 407** tests passing (`pnpm build && pnpm typecheck && pnpm test`); 32 new browser scenarios.
- **CLI smoke checks**: starter and showcase static builds passed; starter browser counter advanced from 0 to 1 without page errors.

## Prioritized Backlog

### Phase 0 — Conformance Baseline (Done)
- [x] Added standalone black-box conformance & visual runner (`scripts/run-conformance.mjs`) orchestrating `http-fixture.mjs`, `socket/echo.cjs`, `@fuck-miniprogram/cli build`, Playwright Chromium, and `tools/visual/capture-browser.cjs` + `compare.cjs` without mutating the conformance suite repository.

### Phase 1 (P0) — Core Framework Gaps (Done)
- [x] **Two-way binding `model:`**: all 7 `model.*` cases passing (parent-to-child sync, child `setData` write-back, `<input model:value>`, observers, shared peer fields, falsy values).
- [x] **WXS `change:prop`, `ownerInstance` & event responders**: `ComponentDescriptor` methods, `change:prop` sequential `setData` delivery (`groupSetData`), and WXS view-layer event responders passing.
- [x] **Subpackage async loading & modern config**: `require.async`, callback `require(path, cb, errCb)`, `componentPlaceholder`, `resolveAlias`, `lazyCodeLoading: "requiredComponents"`, global `usingComponents`, and independent subpackage `app.wxss` isolation (`subpackage.independent-page-in-stack`) passing.
- [x] **Component router, `routeDone` & style edges**: `this.router` / `this.pageRouter`, `pageLifetimes.routeDone`, `pageLifetimes.resize` / `wx.setPageOrientation`, `styleIsolation` (`shared` / `page-shared` / `page-apply-shared` zero-specificity `:where()` scoping), two-level `externalClasses` forwarding, and `~` / `^` class prefixes passing.
- [x] **Events & SelectorQuery**: component-scoped `mark:*` on custom components and elements, `SelectorQuery.fields({ mark, computedStyle })` camelCase-to-kebab conversion, `Canvas` `createImageData` / `createPath2D`, and geometric `IntersectionObserver.relativeTo` for non-ancestor siblings passing.

### Phase 2 (P1) — Runtime APIs, Built-in Components & Compiled Idioms (In Progress)
- [x] **Scroll-driven keyframes**: `this.animate(selector, keyframes, duration, scrollSource)` with per-property Web Animations and `disposeAnimations` cleanup in `src/runtime/animate.ts`.
- [x] **Cache manager**: `wx.createCacheManager` rule matching, `dataSchema`, `maxAge`, `mode: 'always' | 'weakNetwork' | 'none'`, `fromCache` responses, and `wx.request` interception in `src/runtime/api/cache-manager.ts`.
- [x] **Storage / FS / Network / Audio / PageMeta**: AES-GCM IndexedDB `encrypt: true` storage (`storage-crypto.ts`), JSON-detached storage serialization (Date, undefined, sparse arrays, ArrayBuffer, strict boolean `encrypt`, `batchGetStorage` `dataList`), synchronous temp-file byte caching for `downloadFile` + `readFileSync` / `saveFileSync`, `truncateSync` options overload, `InnerAudioContext` `wxfile://` resolution, `SocketTask.send` after close, `uploadFile` progress file-size accounting, `page-meta` `root-font-size` & `scroll-top`.
- [x] **34 built-in components (properties, defaults & controls)**: all 50 `component.defaults.*` / `component.bound.*` and `native.swiper-duration` passing; 33/34 default `render.*` host box checks passing; `WxButton` disabled/loading capture guard, `WxProgress` Web Animation + `activeend`, `WxInput`/`WxTextarea` selection/focus, `WxSlider` numeric `changing` with custom track/thumb rendering, `WxSwiper` controlled `current` + `animationfinish`, and `.fmp-pages` `position: fixed` viewport containment.
- [x] **Compiled-framework idioms**: all `idiom.*` cases passing.
- [x] **Built-in style pass**: audited all 34 catalog components and the additional registered hosts; custom switch/slider/choice controls, image aspect sizing (including transformed parents), input resets, picker/swiper internal layout, progress information, rich-text spacing, media controls, overlay presentation, and extra host defaults. Full pixel parity remains open below.
- [ ] **Remaining `behavior` & visual polish**:
  - `render.input` (0.01px subpixel height rounding)
  - `wxs.object-argument-path-update`, `reuse.key-change-replaces-instance`, `component.moved-on-list-reorder`
  - Remaining visual alignment for choice controls, checked switch, slider, picker text/indicators, media controls, plain button, image edges, and scroll indicators. Progress, textarea, rich-text spacing, and swiper dots now pass; colour profiles are measured separately from style changes.
  - Known Web-platform boundaries: `upload.header-formdata-server` (`Referer` forbidden header), `http.method-full-set` (CORS preflight `Access-Control-Allow-Methods`), `network.udp-loopback-roundtrip` / `network.tcp-fixture-http-read` (no raw UDP/TCP sockets in browser)
