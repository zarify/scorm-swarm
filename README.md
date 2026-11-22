# Micro:bit Swarm SCORM

A browser-based activity builder and SCORM 1.2 learning package for activities using a simulated micro:bit devices
and environmental nodes. You can find the [simulator this is based on here](https://github.com/zarify/swarm_sim).

With this tool you can prepare a simulator scene with one or more micro:bit devices, light, sound, and temperature nodes.
The devices and nodes are all configurable, different micro:bit devices can each be running separate programs (either
MakeCode or Micropython), and can communicate with each other via radio as well as be interacted with through their buttons.

Some functionality has been deliberately left out. See [the main simulator repo](https://github.com/zarify/swarm_sim) for
details and justification.

> [!INFO] LMSes
> This has been tested with Moodle 4.5. Other LMS that support SCORM haven't been tested. YMMV.

## What it does

- Author scenario layout, nodes, and devices.
- Provide interactive hints to students based on events in the simulation like radio messages, button presses and more.
- Author tests using chained triggers and conditions for marking to pass back to an LMS.
- Exports an activity as a SCORM package for uploading to a learning management system, or as activity JSON for reuse.
- Saves learner progress so an activity can be resumed later.

## Quick start

Requires Node.js, npm, Git, and network access to GitHub and npm. A clean clone can fetch the pinned simulator source automatically before building:

```sh
npm install
npm run vendor:sim
npm run build
npm run dev
```

`npm run vendor:sim` fetches the public [`swarm_sim`](https://github.com/zarify/swarm_sim) project at `v0.16.1`, applies this repository's simulator patches, and builds the simulator locally. The generated `vendor/` and `dist/` directories are gitignored; no sibling checkout or machine-specific path is needed. To use a local simulator checkout while developing, set `SWARM_SIM_SRC` to its path.

Using `npm run dev` will fire up the authoring interface on port `3000`. JSON or SCORM zips can be exported from there.

## Requirements

- Node.js, npm, and Git for building and fetching the simulator source.
- Network access to GitHub and npm for the initial simulator fetch and dependency installation.
- A browser to use the builder and learner activity.
- Moodle or another SCORM 1.2-compatible learning platform to host exported packages.

The learner activity runs in the browser and communicates with the simulator embedded in the page. No project-specific Moodle plugin is needed.

