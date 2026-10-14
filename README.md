# Micro:bit Swarm SCORM

A browser-based activity builder and SCORM 1.2 learning package for activities using a Micro:bit swarm simulator. Teachers can prepare a simulator scene, write instructions and hints, define automated checks, preview the learner experience, then export the activity for use in Moodle.

## What it does

- Lets activity authors configure an activity and its swarm simulator scene in a browser-based builder.
- Supports hints and checks that evaluate learner progress as they use the simulator.
- Saves learner progress so an activity can be resumed later.
- Exports an activity as a SCORM package for uploading to a learning management system, or as activity JSON for reuse.

## Quick start

Requires Node.js and npm. To build the project, first make the simulator available, then build and start the local server:

```sh
npm install
npm run vendor:sim
npm run build
npm run dev
```

Open the local address shown by the dev server (port 3000 by default) and use the Activity Builder. The simulator vendoring step uses `~/Code/microbit/swarm_sim` by default; set `SWARM_SIM_SRC` if your simulator checkout is somewhere else.

To create a SCORM ZIP from a built package:

```sh
npm run export
```

The builder can also export a SCORM package directly.

## Requirements

- Node.js and npm for building and running the project.
- A Git checkout of the Micro:bit swarm simulator for `npm run vendor:sim`.
- A browser to use the builder and learner activity.
- Moodle or another SCORM 1.2-compatible learning platform to host exported packages.

The learner activity runs in the browser and communicates with the simulator embedded in the page. No project-specific Moodle plugin is needed.
