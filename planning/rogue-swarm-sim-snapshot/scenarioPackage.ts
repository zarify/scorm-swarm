import { zipSync } from 'fflate';
import { encodeProjectBundle } from './projectBundle';
import type { ScenarioCheckpoint, ScenarioDefinition, SwarmProject } from './project';

const textEncoder = new TextEncoder();
const DISTRACTOR_POOL = [
  'range',
  'channel',
  'variable',
  'loop',
  'light sensor',
  'serial log',
  'temperature',
  'broadcast',
  'receiver',
  'timer',
];

export async function buildScenarioScormPackage(project: SwarmProject): Promise<Uint8Array> {
  const scenario = project.scenarioDefinition;
  if (!scenario) {
    throw new Error('Add scenario authoring details before exporting a SCORM package');
  }

  const bundleBytes = await encodeProjectBundle(project);
  const xml = buildScenarioMoodleXml(project);
  const zipEntries = {
    'imsmanifest.xml': textEncoder.encode(buildScormManifest(scenario)),
    'index.html': textEncoder.encode(buildLaunchHtml(project, scenario)),
    'scenario.json': textEncoder.encode(JSON.stringify(scenario, null, 2)),
    'moodle-question-bank.xml': textEncoder.encode(xml),
    [`bundles/${slugForFilename(project.name)}.swarm`]: bundleBytes,
    'README.txt': textEncoder.encode(buildReadme()),
  };

  return zipSync(zipEntries, { level: 0 });
}

export function buildScenarioMoodleXml(project: SwarmProject): string {
  const scenario = project.scenarioDefinition;
  if (!scenario) {
    throw new Error('Add scenario authoring details before exporting Moodle questions');
  }

  const questions = scenario.checkpoints.flatMap((checkpoint, index) =>
    buildCheckpointQuestions(project, scenario, checkpoint, index),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<quiz>
  <question type="category">
    <category><text>$course$/${escapeXml(project.name)}/${escapeXml(scenario.title)}</text></category>
  </question>
  <question type="description">
    <name><text>${escapeXml(scenario.title)} overview</text></name>
    <questiontext format="html"><text><![CDATA[${wrapHtml([
      `<p>${escapeXml(scenario.summary)}</p>`,
      `<p><strong>Runtime target:</strong> ${escapeXml(
        scenario.runtimeTarget === 'micropython' ? 'MicroPython' : 'MakeCode',
      )}</p>`,
    ])}]]></text></questiontext>
  </question>
  ${questions.join('\n')}
</quiz>`;
}

function buildCheckpointQuestions(
  project: SwarmProject,
  scenario: ScenarioDefinition,
  checkpoint: ScenarioCheckpoint,
  index: number,
): string[] {
  const baseName = `${index + 1}. ${checkpoint.prompt}`;
  const teacherLookFor = [
    scenario.learningObjectivesMarkdown ? `Objectives: ${scenario.learningObjectivesMarkdown}` : '',
    scenario.teacherNotesMarkdown ? `Teacher notes: ${scenario.teacherNotesMarkdown}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const essay = `
  <question type="essay">
    <name><text>${escapeXml(baseName)}</text></name>
    <questiontext format="html"><text><![CDATA[${wrapHtml([
      `<p>${escapeXml(checkpoint.prompt)}</p>`,
      `<p><strong>Simulation:</strong> ${escapeXml(project.name)}</p>`,
    ])}]]></text></questiontext>
    <generalfeedback format="html"><text><![CDATA[${wrapHtml([
      `<p>${escapeXml(scenario.summary)}</p>`,
    ])}]]></text></generalfeedback>
    <defaultgrade>2.0000000</defaultgrade>
    <penalty>0.0000000</penalty>
    <hidden>0</hidden>
    <responseformat>editor</responseformat>
    <responserequired>1</responserequired>
    <responsefieldlines>12</responsefieldlines>
    <attachments>0</attachments>
    <attachmentsrequired>0</attachmentsrequired>
    <graderinfo format="html"><text><![CDATA[${wrapHtml([
      checkpoint.expectedKeywords.length > 0
        ? `<p><strong>Expected concepts:</strong> ${escapeXml(checkpoint.expectedKeywords.join(', '))}</p>`
        : '',
      teacherLookFor ? `<p>${escapeXml(teacherLookFor)}</p>` : '',
    ])}]]></text></graderinfo>
    <responsetemplate format="html"><text></text></responsetemplate>
  </question>`;

  if (checkpoint.expectedKeywords.length === 0) {
    return [essay];
  }

  const shortAnswer = `
  <question type="shortanswer">
    <name><text>${escapeXml(`${baseName} keyword check`)}</text></name>
    <questiontext format="html"><text><![CDATA[${wrapHtml([
      `<p>Type one key concept that belongs in a strong answer to this scenario prompt.</p>`,
      `<p><strong>Prompt:</strong> ${escapeXml(checkpoint.prompt)}</p>`,
    ])}]]></text></questiontext>
    <generalfeedback format="html"><text><![CDATA[<p>This auto-marked question checks whether the student can identify a core scenario concept.</p>]]></text></generalfeedback>
    <defaultgrade>1.0000000</defaultgrade>
    <penalty>0.3333333</penalty>
    <hidden>0</hidden>
    <usecase>0</usecase>
    ${checkpoint.expectedKeywords
      .map(
        (keyword) => `
    <answer fraction="${formatFraction(100 / checkpoint.expectedKeywords.length)}" format="moodle_auto_format">
      <text><![CDATA[${keyword}]]></text>
      <feedback format="html"><text>Relevant concept recognised.</text></feedback>
    </answer>`,
      )
      .join('')}
  </question>`;

  return [essay, shortAnswer];
}

function buildScormManifest(scenario: ScenarioDefinition): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="swarm-scenario" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="
    http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
    http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="swarm-org">
    <organization identifier="swarm-org">
      <title>${escapeXml(scenario.title)}</title>
      <item identifier="swarm-item" identifierref="swarm-resource">
        <title>${escapeXml(scenario.title)}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="swarm-resource" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html" />
      <file href="scenario.json" />
      <file href="moodle-question-bank.xml" />
    </resource>
  </resources>
</manifest>`;
}

function buildLaunchHtml(project: SwarmProject, scenario: ScenarioDefinition): string {
  const autoMarkableCheckpoints = scenario.checkpoints.filter(
    (checkpoint) => checkpoint.expectedKeywords.length > 0,
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeXml(scenario.title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #081316; color: #e8ffff; }
      main { max-width: 960px; margin: 0 auto; padding: 2rem; }
      section { background: rgba(105,247,255,0.08); border: 1px solid rgba(105,247,255,0.24); border-radius: 16px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
      code { background: rgba(0,0,0,0.25); padding: 0.2rem 0.35rem; border-radius: 6px; }
      .checkpoint { border-top: 1px solid rgba(105,247,255,0.18); padding-top: 1rem; margin-top: 1rem; }
      .choices { display: grid; gap: 0.5rem; margin: 0.75rem 0; }
      textarea { width: 100%; min-height: 8rem; background: rgba(0,0,0,0.25); color: #e8ffff; border: 1px solid rgba(105,247,255,0.24); border-radius: 12px; padding: 0.8rem; }
      button { border: 1px solid rgba(105,247,255,0.3); background: rgba(105,247,255,0.12); color: #e8ffff; border-radius: 12px; padding: 0.8rem 1rem; font: inherit; cursor: pointer; }
      .result { margin-top: 1rem; padding: 0.8rem 1rem; border-radius: 12px; background: rgba(105,247,255,0.08); }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>${escapeXml(scenario.title)}</h1>
        <p>${escapeXml(scenario.summary)}</p>
        <p><strong>Runtime target:</strong> ${escapeXml(
          scenario.runtimeTarget === 'micropython' ? 'MicroPython' : 'MakeCode',
        )}</p>
      </section>
      <section>
        <h2>Learning objectives</h2>
        <pre>${escapeXml(scenario.learningObjectivesMarkdown ?? 'Not provided')}</pre>
      </section>
      <section>
        <h2>Teacher notes</h2>
        <pre>${escapeXml(scenario.teacherNotesMarkdown ?? 'Not provided')}</pre>
      </section>
      <section>
        <h2>Interactive checkpoint activity</h2>
        <p>Students can answer the prompts here and submit an auto-marked score back through SCORM.</p>
        <p><strong>Auto-markable checkpoints:</strong> ${autoMarkableCheckpoints.length} of ${scenario.checkpoints.length}</p>
        <div id="checkpoint-list">
          ${scenario.checkpoints
            .map(
              (checkpoint, index) =>
                `<article class="checkpoint" data-checkpoint-id="${escapeXml(checkpoint.id)}">
                  <h3>${index + 1}. ${escapeXml(checkpoint.prompt)}</h3>
                  ${
                    checkpoint.expectedKeywords.length > 0
                      ? `
                        <p>Select the concepts that belong in a strong answer.</p>
                        <div class="choices">
                          ${buildScormChoiceOptions(checkpoint).join('')}
                        </div>
                      `
                      : '<p>This checkpoint is reflection-only and is not auto-marked in the SCORM package.</p>'
                  }
                  <label>
                    <span>Your explanation</span>
                    <textarea data-response="${escapeXml(checkpoint.id)}" placeholder="Explain your thinking here"></textarea>
                  </label>
                </article>`,
            )
            .join('')}
        </div>
        <button type="button" id="submit-score">Submit score to Moodle</button>
        <div class="result" id="result">No score submitted yet.</div>
      </section>
      <section>
        <h2>Package contents</h2>
        <p>This SCORM prototype bundle includes:</p>
        <ul>
          <li>a saved Swarm project bundle: <code>bundles/${escapeXml(
            slugForFilename(project.name),
          )}.swarm</code></li>
          <li>a Moodle question bank export: <code>moodle-question-bank.xml</code></li>
          <li>scenario metadata for future packaging work</li>
        </ul>
        <p>The current score comes from the checkpoint interactions on this page and is reported through the SCORM runtime to the Moodle gradebook.</p>
      </section>
    </main>
    <script>
      ${buildScormRuntimeScript(scenario)}
    </script>
  </body>
</html>`;
}

function buildReadme(): string {
  return [
    'This SCORM package is an initial Swarm scenario-export prototype.',
    '',
    'It preserves scenario authoring metadata, the saved Swarm bundle, a Moodle XML question bank, and a self-contained SCORM launch page that reports score and status back to the LMS gradebook.',
    '',
    'Current limitations:',
    '- The package is not yet a full self-contained embedded Swarm runtime.',
    '- SCORM marks currently come from the scenario checkpoint interactions on the launch page, not from a fully embedded live Swarm canvas.',
  ].join('\n');
}

function buildScormChoiceOptions(checkpoint: ScenarioCheckpoint): string[] {
  const distractors = DISTRACTOR_POOL.filter(
    (keyword) => !checkpoint.expectedKeywords.includes(keyword),
  ).slice(0, Math.max(2, checkpoint.expectedKeywords.length));
  const options = [...checkpoint.expectedKeywords, ...distractors];

  return options.map(
    (option) => `
      <label>
        <input
          type="checkbox"
          data-kind="${checkpoint.expectedKeywords.includes(option) ? 'correct' : 'distractor'}"
          data-checkpoint="${escapeXml(checkpoint.id)}"
          value="${escapeXml(option)}"
        />
        ${escapeXml(option)}
      </label>`,
  );
}

function buildScormRuntimeScript(scenario: ScenarioDefinition): string {
  const checkpointMap = scenario.checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    expectedKeywords: checkpoint.expectedKeywords,
  }));

  return `
    const checkpointConfig = ${JSON.stringify(checkpointMap)};

    function findApi(win) {
      let tries = 0;
      while (win && !win.API && win.parent && win.parent !== win && tries < 20) {
        tries += 1;
        win = win.parent;
      }
      return win ? win.API : null;
    }

    const scormApi = findApi(window);
    let initialized = false;

    function initializeScorm() {
      if (!scormApi || initialized) {
        return;
      }
      initialized = scormApi.LMSInitialize("") === "true";
      if (!initialized) {
        return;
      }
      scormApi.LMSSetValue("cmi.core.score.min", "0");
      scormApi.LMSSetValue("cmi.core.score.max", "100");
      scormApi.LMSSetValue("cmi.core.lesson_status", "incomplete");
      scormApi.LMSCommit("");
    }

    function calculateScore() {
      const autoMarkable = checkpointConfig.filter((checkpoint) => checkpoint.expectedKeywords.length > 0);
      if (autoMarkable.length === 0) {
        return { raw: 100, detail: "No auto-markable checkpoints configured; reporting completion only." };
      }

      let totalScore = 0;

      autoMarkable.forEach((checkpoint) => {
        const selected = Array.from(
          document.querySelectorAll('input[data-checkpoint="' + checkpoint.id + '"]:checked')
        );
        const correctSelections = selected.filter((input) => input.dataset.kind === "correct").length;
        const incorrectSelections = selected.filter((input) => input.dataset.kind === "distractor").length;
        const normalized = Math.max(
          0,
          (correctSelections - incorrectSelections) / Math.max(1, checkpoint.expectedKeywords.length)
        );
        totalScore += normalized;
      });

      const raw = Math.round((totalScore / autoMarkable.length) * 100);
      return { raw, detail: autoMarkable.length + " auto-markable checkpoint(s) scored." };
    }

    function captureSuspendData() {
      return JSON.stringify({
        responses: Array.from(document.querySelectorAll("textarea[data-response]")).map((field) => ({
          checkpointId: field.getAttribute("data-response"),
          text: field.value,
        })),
        selections: Array.from(document.querySelectorAll('input[type="checkbox"][data-checkpoint]')).filter((field) => field.checked).map((field) => ({
          checkpointId: field.getAttribute("data-checkpoint"),
          value: field.value,
        })),
      }).slice(0, 4000);
    }

    function submitScore() {
      initializeScorm();
      const result = calculateScore();
      const status = result.raw >= 70 ? "passed" : "failed";
      const resultNode = document.getElementById("result");
      if (resultNode) {
        resultNode.textContent = "Reported " + result.raw + "/100 to SCORM gradebook. Status: " + status + ". " + result.detail;
      }
      if (!scormApi || !initialized) {
        if (resultNode) {
          resultNode.textContent += " SCORM API was not available in this preview context.";
        }
        return;
      }
      scormApi.LMSSetValue("cmi.core.score.raw", String(result.raw));
      scormApi.LMSSetValue("cmi.core.lesson_status", status);
      scormApi.LMSSetValue("cmi.suspend_data", captureSuspendData());
      scormApi.LMSCommit("");
    }

    initializeScorm();
    window.addEventListener("beforeunload", () => {
      if (scormApi && initialized) {
        scormApi.LMSCommit("");
        scormApi.LMSFinish("");
      }
    });
    document.getElementById("submit-score")?.addEventListener("click", submitScore);
  `;
}

function slugForFilename(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'swarm-scenario';
}

function wrapHtml(parts: string[]): string {
  return parts.filter(Boolean).join('');
}

function formatFraction(value: number): string {
  return value.toFixed(5);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
