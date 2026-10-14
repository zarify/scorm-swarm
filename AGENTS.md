# Repository Guidelines

## Project Overview

This repository builds a browser-based activity authoring tool and SCORM 1.2 learner package around a Micro:bit swarm simulator. Authors configure an activity, simulator scene, scripted checks, and hints; the builder exports JSON or a Moodle-uploadable SCORM ZIP.

## Architecture & Data Flow

- `scripts/vendor-sim.js` clones upstream `swarm_sim` tag `v0.16.0` by default, overlays `sim-patch/src/`, applies `sim-patch/edits.patch`, builds it, and places assets in `dist/sim/`. Set `SWARM_SIM_SRC` to use a local committed checkout.
- `scripts/build.js` normalizes and validates activity configuration and scene bundles, bundles builder and learner browser entry points with esbuild, and assembles `dist/` output. The SCORM target needs simulator assets first.
- `src/activity-builder/` authors configuration and scenarios; browser-side export packages config, manifest, template, and simulator assets.
- `src/scorm-template/` loads the activity and simulator in an iframe. `src/shared/sim-bridge.js` owns the versioned, origin/source-checked `postMessage` protocol. Simulator events feed `test-runner.js`, `effect-evaluator.js`, and `hint-evaluator.js`.
- Learner scene state persists through SCORM `suspend_data` and IndexedDB (`session-persistence.js` / `state-codec.js`). `npm run export` separately zips an already-built SCORM template.

## Key Directories

- `src/shared/` — configuration schema, normalization/validation, simulator bridge, SWARM bundle handling, grading, hints, and inline rendering.
- `src/activity-builder/` — browser authoring UI, tabs, preview, and JSON/SCORM export.
- `src/scorm-template/` — learner-facing HTML, styles, runtime, SCORM wrapper, and manifest template.
- `sim-patch/` — overlay files and patch applied to upstream simulator source; simulator-side changes belong here, not in generated `vendor/`.
- `scripts/` — vendoring, builds, dev server, ZIP export, and demo scene generation.
- `test/` — Node tests, browser runtime tests, fixtures, and helpers.
- `examples/` — sample activity JSON and `.swarm` scene.
- `vendor/` and `dist/` — generated/ignored simulator checkout and build output. `planning/` contains a separate planning snapshot, not part of the root app build.

## Development Commands

```sh
npm install
npm run vendor:sim       # required before SCORM build if dist/sim is absent
npm run build            # builder + SCORM
npm run build:builder
npm run build:scorm
npm run dev              # serves dist/ at 127.0.0.1:3000; PORT overrides
npm test                 # root Node test suite
npm run test:browser     # builds, then runs Playwright browser suite
npm run export           # zip previously built SCORM template
```

`npm run vendor:sim` clones the pinned public simulator release into a temporary directory by default; set `SWARM_SIM_SRC` to use another committed checkout. It requires Git/network access and runs the vendored project's `npm ci` and build. Build scripts accept `--target=builder|scorm` (also exposed as npm scripts), and `scripts/build.js` supports `--config=` and `--scene=`. `scripts/make-demo-scene.js` requires `--out <path>` or `--out=<path>`.

## Code Conventions & Common Patterns

- Root application code is JavaScript ES modules; shared modules use named exports. The simulator overlay also contains TypeScript. Root build bundles browser IIFEs targeting ES2022; there is no root TypeScript, lint, or formatter configuration.
- Keep activity config changes aligned across `src/shared/activity-config.schema.json`, `config-normalizer.js`, `config-validator.js`, builder UI, learner consumers, and tests. Normalize before validation/runtime use; validation rejects unknown fields and returns path/message errors.
- Keep cross-frame simulator communication behind `src/shared/sim-bridge.js`; preserve protocol version, source/origin checks, and request/response correlation.
- Reuse the existing controller/factory style for stateful behavior (for example `createTestRunner`, `createSessionPersistence`). Keep simulator-specific edits in `sim-patch/` so vendoring can regenerate them.

## Important Files

- `package.json` — root npm commands and dependencies.
- `scripts/vendor-sim.js`, `scripts/build.js`, `scripts/dev.js`, `scripts/export-scorm.js` — simulator acquisition, app builds, local server, and ZIP packaging.
- `src/shared/activity-config.schema.json`, `config-normalizer.js`, `config-validator.js` — config contract and processing.
- `src/shared/sim-bridge.js`, `swarm-bundle.js`, `test-runner.js`, `effect-evaluator.js`, `hint-evaluator.js` — simulator protocol, scene format, grading, and hints.
- `src/activity-builder/js/app.js`, `src/scorm-template/js/app.js` — builder and learner orchestration.
- `src/scorm-template/js/scorm-wrapper.js`, `session-persistence.js`, `state-codec.js` — LMS integration and persistence.
- `examples/demo-activity.json`, `examples/two-device-demo.swarm` — example inputs.

## Runtime/Tooling Preferences

Use npm and Node.js for root scripts; the root package is private and ES-module (`"type": "module"`). No root Node version or package-manager version is pinned. The lockfile’s Playwright packages declare Node >=20, so Node 20+ is the practical choice when installing/running browser tests. Root bundling uses esbuild; browser tests use Playwright. Simulator vendoring/building has its own nested npm toolchain. Do not edit generated `vendor/` or `dist/` as the source of truth.

## Testing & QA

- `npm test` uses Node’s built-in test runner (`node --test "test/*.test.js"`) for shared logic, config, evaluation, persistence, SCORM, and package behavior.
- `npm run test:browser` builds first, then runs Playwright tests under `test/browser/` against the browser runtime and fixtures. A usable Chromium/headless-shell executable is required by the browser suite.
- The root package defines no lint, formatter, or CI command. The vendored simulator has separate tests/typecheck/E2E commands; those are not the root application suite.
- For behavioral changes, cover relevant boundaries and integration contracts, especially config-schema/normalizer/validator agreement, bridge protocol behavior, and persistence/LMS outcomes. Run the specific root suite and browser suite when the changed path requires a real browser.
