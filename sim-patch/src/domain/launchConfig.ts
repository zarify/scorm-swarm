export interface SwarmLaunchConfig {
  learnerMode: boolean;
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

  return {
    learnerMode,
    ...(bundlePath ? { bundlePath } : {}),
  };
}
