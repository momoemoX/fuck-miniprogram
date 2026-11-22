# Roadmap

This repository implements a pure-Web Mini Program runtime (`@fuck-miniprogram/engine`) and CLI (`@fuck-miniprogram/cli`).

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
