# Micro:bit Swarm SCORM

A browser-based activity builder and SCORM 1.2 learning package for activities using a Micro:bit swarm simulator. Teachers can prepare a simulator scene, write instructions and hints, define automated checks, preview the learner experience, then export the activity for use in Moodle.

## What it does

- Lets activity authors configure an activity and its swarm simulator scene in a browser-based builder.
- Supports hints and checks that evaluate learner progress as they use the simulator.
- Saves learner progress so an activity can be resumed later.
- Exports an activity as a SCORM package for uploading to a learning management system, or as activity JSON for reuse.

## Quick start

Requires Node.js, npm, Git, and network access to GitHub and npm. A clean clone can fetch the pinned simulator source automatically before building:

```sh
npm install
npm run vendor:sim
npm run build
npm run dev
```

`npm run vendor:sim` fetches the public [`swarm_sim`](https://github.com/zarify/swarm_sim) project at `v0.16.0`, applies this repository's simulator patches, and builds the simulator locally. The generated `vendor/` and `dist/` directories are gitignored; no sibling checkout or machine-specific path is needed. To use a local simulator checkout while developing, set `SWARM_SIM_SRC` to its path.

To create a SCORM ZIP from a built package:

```sh
npm run export
```

The builder can also export a SCORM package directly.

## Requirements

- Node.js, npm, and Git for building and fetching the simulator source.
- Network access to GitHub and npm for the initial simulator fetch and dependency installation.
- A browser to use the builder and learner activity.
- Moodle or another SCORM 1.2-compatible learning platform to host exported packages.

The learner activity runs in the browser and communicates with the simulator embedded in the page. No project-specific Moodle plugin is needed.

## Versioning

The authoring tool's own version is the `version` field in `package.json` (semver,
shown as `v0.1.0` in the builder header next to the title). `scripts/build.js`
injects it into the builder bundle at build time — bump `package.json` and rebuild
to release. It is independent of the vendored simulator version (`v0.16.0`, pinned
by `scripts/vendor-sim.js`).
