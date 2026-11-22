# fuck-miniprogram

A pure-Web Mini Program runtime, WXML/WXSS/WXS compiler, and CLI.

- **Pure Web runtime**: compiles WXML templates into static DOM builders with path-trie `setData` patching — no virtual DOM, no iframe bridge.
- **Monorepo structure**: core runtime & compiler live in `packages/engine`; CLI lives in `packages/cli`.

> **Disclaimer**: This is an independent open-source project for running Mini Program source code (`WXML` / `WXSS` / `WXS` / `JS`) in standard Web browsers. It is not affiliated with or endorsed by Tencent or WeChat.

## Structure

```text
packages/
├── engine/   @fuck-miniprogram/engine  # Web runtime + WXML/WXSS/WXS compiler
└── cli/      @fuck-miniprogram/cli     # CLI (`fmp dev` / `fmp build`)
examples/
└── starter/                            # Minimal starter project
tests/
├── unit/                               # 21 unit test suites
└── integration/                        # Compiler & bundle integration tests
```

## Quick Start

```bash
pnpm install
pnpm build
pnpm test

# Run the starter project in the browser with hot reload
pnpm dev:starter

# Or use the CLI directly on any project directory
node packages/cli/dist/index.js dev ./examples/starter --port 3000
node packages/cli/dist/index.js build ./examples/starter --out ./dist-web
```

## Conformance & Roadmap

Black-box conformance is tracked against [`fuck-miniprogram-conformance-tests`](https://github.com/momoemoX/fuck-miniprogram-conformance-tests). See [`ROADMAP.md`](./ROADMAP.md) for the implementation backlog.

## Third-Party Notices

Third-party library attributions and licenses are documented in [`packages/engine/THIRD_PARTY_NOTICES.md`](./packages/engine/THIRD_PARTY_NOTICES.md).
