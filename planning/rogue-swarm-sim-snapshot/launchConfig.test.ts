import { readLaunchConfig } from './launchConfig';

describe('launchConfig', () => {
  it('defaults to normal mode with no URL', () => {
    expect(readLaunchConfig(undefined)).toEqual({ learnerMode: false });
  });

  it('reads learner mode and bundled scenario path from query parameters', () => {
    expect(
      readLaunchConfig(
        'https://example.invalid/index.html?mode=learner&bundle=bundles/radio-lab.swarm',
      ),
    ).toEqual({
      learnerMode: true,
      bundlePath: 'bundles/radio-lab.swarm',
    });
  });
});
