import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScenarioDefinition } from '../domain/project';

interface ScenarioAuthoringModalProps {
  initialScenario?: ScenarioDefinition;
  onClose: () => void;
  onSave: (nextScenario: ScenarioDefinition | undefined) => void;
}

export function ScenarioAuthoringModal({
  initialScenario,
  onClose,
  onSave,
}: ScenarioAuthoringModalProps) {
  const titleRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(initialScenario?.title ?? '');
  const [summary, setSummary] = useState(initialScenario?.summary ?? '');
  const [runtimeTarget, setRuntimeTarget] = useState<ScenarioDefinition['runtimeTarget']>(
    initialScenario?.runtimeTarget ?? 'makecode-pxt',
  );
  const [learningObjectivesMarkdown, setLearningObjectivesMarkdown] = useState(
    initialScenario?.learningObjectivesMarkdown ?? '',
  );
  const [teacherNotesMarkdown, setTeacherNotesMarkdown] = useState(
    initialScenario?.teacherNotesMarkdown ?? '',
  );
  const [checkpointLines, setCheckpointLines] = useState(() => serializeCheckpoints(initialScenario));

  useEffect(() => {
    setTitle(initialScenario?.title ?? '');
    setSummary(initialScenario?.summary ?? '');
    setRuntimeTarget(initialScenario?.runtimeTarget ?? 'makecode-pxt');
    setLearningObjectivesMarkdown(initialScenario?.learningObjectivesMarkdown ?? '');
    setTeacherNotesMarkdown(initialScenario?.teacherNotesMarkdown ?? '');
    setCheckpointLines(serializeCheckpoints(initialScenario));
  }, [initialScenario]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const checkpointHint = useMemo(
    () => 'One checkpoint per line in the form: prompt | keyword 1, keyword 2',
    [],
  );

  return (
    <div
      className="instructions-editor-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Scenario authoring editor"
      onClick={onClose}
    >
      <div className="instructions-editor-modal__card" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="instructions-editor-modal__close"
          aria-label="Close scenario authoring editor"
          onClick={onClose}
        >
          ×
        </button>
        <p className="metric-label">Scenario authoring</p>
        <div className="instructions-editor-modal__header">
          <strong>Build a Moodle-friendly simulation scenario</strong>
          <span>Capture the lesson framing, runtime target, and checkpoint prompts for export.</span>
        </div>
        <div className="scenario-editor-grid">
          <label className="scenario-editor-field">
            <span>Scenario title</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Radio relay investigation"
            />
          </label>
          <label className="scenario-editor-field">
            <span>Runtime target</span>
            <select
              value={runtimeTarget}
              onChange={(event) =>
                setRuntimeTarget(event.target.value as ScenarioDefinition['runtimeTarget'])
              }
            >
              <option value="makecode-pxt">MakeCode</option>
              <option value="micropython">MicroPython</option>
            </select>
          </label>
          <label className="scenario-editor-field scenario-editor-field--wide">
            <span>Scenario summary</span>
            <textarea
              className="instructions-editor-modal__textarea scenario-editor-textarea--short"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Students investigate why one node never receives the expected radio message."
              spellCheck={false}
            />
          </label>
          <label className="scenario-editor-field scenario-editor-field--wide">
            <span>Learning objectives</span>
            <textarea
              className="instructions-editor-modal__textarea scenario-editor-textarea"
              value={learningObjectivesMarkdown}
              onChange={(event) => setLearningObjectivesMarkdown(event.target.value)}
              placeholder="- Explain radio message flow&#10;- Identify why a node misses packets&#10;- Justify a debugging change"
              spellCheck={false}
            />
          </label>
          <label className="scenario-editor-field scenario-editor-field--wide">
            <span>Teacher notes</span>
            <textarea
              className="instructions-editor-modal__textarea scenario-editor-textarea"
              value={teacherNotesMarkdown}
              onChange={(event) => setTeacherNotesMarkdown(event.target.value)}
              placeholder="- Ask students to predict behaviour before reset&#10;- Pause on the first failed packet"
              spellCheck={false}
            />
          </label>
          <label className="scenario-editor-field scenario-editor-field--wide">
            <span>Checkpoint prompts</span>
            <textarea
              className="instructions-editor-modal__textarea scenario-editor-textarea"
              aria-label="Scenario checkpoint lines"
              value={checkpointLines}
              onChange={(event) => setCheckpointLines(event.target.value)}
              placeholder="What caused the failure? | radio, group, packet&#10;How would you fix it? | debug, change, because"
              spellCheck={false}
            />
          </label>
        </div>
        <p className="hint">{checkpointHint}</p>
        <div className="instructions-editor-modal__actions">
          <button type="button" onClick={() => onSave(undefined)}>
            Clear scenario
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onSave({
                title,
                summary,
                runtimeTarget,
                learningObjectivesMarkdown,
                teacherNotesMarkdown,
                checkpoints: parseCheckpointLines(checkpointLines),
              })
            }
          >
            Save scenario
          </button>
        </div>
      </div>
    </div>
  );
}

function serializeCheckpoints(initialScenario: ScenarioDefinition | undefined): string {
  return (initialScenario?.checkpoints ?? [])
    .map((checkpoint) => `${checkpoint.prompt} | ${checkpoint.expectedKeywords.join(', ')}`)
    .join('\n');
}

function parseCheckpointLines(value: string): ScenarioDefinition['checkpoints'] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [promptPart, keywordsPart = ''] = line.split('|');
      return {
        id: `checkpoint-${index + 1}`,
        prompt: promptPart?.trim() ?? '',
        expectedKeywords: keywordsPart
          .split(',')
          .map((keyword) => keyword.trim())
          .filter(Boolean),
      };
    });
}
