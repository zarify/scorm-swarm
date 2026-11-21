export interface SwarmLaunchConfig {
  learnerMode: boolean;
  /** The scenario editor hosts this frame to author starting rules and blank code. */
  scenarioAuthoring?: true;
  bundlePath?: string;
}

export function readLaunchConfig(url: string | undefined): SwarmLaunchConfig {
  if (!url) {
    return { learnerMode: false };
  }

  const parsed = new URL(url, 'http://localhost/');
  const bundlePath = parsed.searchParams.get('bundle')?.trim() || undefined;
  const mode = parsed.searchParams.get('mode')?.trim().toLowerCase();
  const learnerMode =
    mode === 'learner' ||
    parsed.searchParams.get('learner') === '1' ||
    parsed.searchParams.get('readonly') === '1';
  const scenarioAuthoring = mode === 'scenario' && !learnerMode;

  return {
    learnerMode,
    ...(scenarioAuthoring ? { scenarioAuthoring: true as const } : {}),
    ...(bundlePath ? { bundlePath } : {}),
  };
}
