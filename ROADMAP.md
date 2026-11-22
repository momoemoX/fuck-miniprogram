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

## Prioritized Backlog

### Phase 0 — Conformance Baseline
- Run `fuck-miniprogram-conformance-tests` (740 automated cases + 61 visual references) against `@fuck-miniprogram/engine` via `@fuck-miniprogram/cli` to generate an objective failure breakdown (`behavior` / `shape` / `quirk`).

### Phase 1 (P0) — Core Framework Gaps
1. **Two-way binding `model:`** (`src/compiler/parser.ts`, `codegen.ts`, `src/runtime/builder.ts`, `component.ts`, `native.ts`): parent-to-child prop sync + child `setData` write-back + `<input model:value>`.
2. **WXS `change:prop`, `ownerInstance` & event responders** (`src/compiler/parser.ts`, `codegen.ts`, `wxs.ts`, `src/runtime/builder.ts`, `component.ts`): `ComponentDescriptor` (`selectComponent`, `selectAllComponents`, `setStyle`, `addClass`/`removeClass`/`hasClass`, `getDataset`, `getState`, `callMethod`, `triggerEvent`) and `bind:event="{{wxs.fn}}"` returning `false` to stop bubbling.
3. **Subpackage async loading & modern config** (`src/compiler/build.ts`, `src/runtime/modules.ts`, `component.ts`, `index.ts`): `require.async`, callback `require(path, cb, errCb)`, `componentPlaceholder`, `app.json` `resolveAlias` (for `require()` only), `lazyCodeLoading: "requiredComponents"`, and `getApp({ allowDefault: true })` for independent subpackages.
4. **Component router, `routeDone` & style edges** (`src/runtime/component.ts`, `api/route.ts`, `styles.ts`, `src/compiler/wxss.ts`): `this.router` / `this.pageRouter`, `pageLifetimes.routeDone`, `styleIsolation: "page-apply-shared"`, and `~` / `^` class prefixes.

### Phase 2 (P1) — Runtime APIs, Built-in Components & Compiled Idioms
1. **Scroll-driven keyframes**: `this.animate(selector, keyframes, duration, scrollSource)` in `src/runtime/animate.ts`.
2. **Cache manager**: `wx.createCacheManager`.
3. **34 built-in components**: align default attributes, bound type coercion, and v2 host box styles against the component catalog and visual references.
4. **Compiled-framework idioms**: verify Taro/uni-app output patterns (`tmpl_*` recursion, WXS-computed `template is`, `u-i`/`u-p`/`bind:__l`, `eh` dispatcher, `data-v-*` scoped selectors, `wx://form-field`).
