import { unzipSync } from 'fflate';
import { createBlankProject, type SwarmProject } from './project';
import { buildScenarioMoodleXml, buildScenarioScormPackage } from './scenarioPackage';

const now = '2026-09-01T10:00:00.000Z';

describe('scenarioPackage', () => {
  it('builds Moodle XML with essay and short-answer questions from scenario checkpoints', () => {
    const project: SwarmProject = {
      ...createBlankProject({ id: 'project-1', name: 'Swarm relay', now }),
      scenarioDefinition: {
        title: 'Relay investigation',
        summary: 'Students debug a relay path.',
        runtimeTarget: 'micropython',
        checkpoints: [
          {
            id: 'checkpoint-1',
            prompt: 'What caused the failure?',
            expectedKeywords: ['radio', 'group'],
          },
        ],
      },
      devices: [],
      artifacts: [],
      environmentSources: [],
    };

    const xml = buildScenarioMoodleXml(project);

    expect(xml).toContain('<question type="essay">');
    expect(xml).toContain('<question type="shortanswer">');
    expect(xml).toContain('Relay investigation');
    expect(xml).toContain('radio');
    expect(xml).toContain('group');
  });

  it('builds a SCORM package whose launch page reports score and status through the SCORM API', async () => {
    const project: SwarmProject = {
      ...createBlankProject({ id: 'project-2', name: 'Swarm relay', now }),
      scenarioDefinition: {
        title: 'Relay investigation',
        summary: 'Students debug a relay path.',
        runtimeTarget: 'makecode-pxt',
        checkpoints: [
          {
            id: 'checkpoint-1',
            prompt: 'What caused the failure?',
            expectedKeywords: ['radio', 'group'],
          },
        ],
      },
      devices: [],
      artifacts: [],
      environmentSources: [],
    };

    const bytes = await buildScenarioScormPackage(project);
    const archive = unzipSync(bytes);
    const launchPage = archive['index.html'];

    expect(launchPage).toBeDefined();

    const text = new TextDecoder().decode(launchPage);

    expect(text).toContain('LMSInitialize');
    expect(text).toContain('cmi.core.score.raw');
    expect(text).toContain('cmi.core.lesson_status');
  });
});
