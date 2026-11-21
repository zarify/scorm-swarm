import { describe, expect, it } from 'vitest';
import { readLaunchConfig } from './launchConfig';

describe('readLaunchConfig', () => {
  it('defaults to standard mode without a URL', () => {
    expect(readLaunchConfig(undefined)).toEqual({ learnerMode: false });
  });

  it.each([
    ['mode=learner', 'https://example.invalid/index.html?mode=learner'],
    ['learner=1', 'https://example.invalid/index.html?learner=1'],
    ['readonly=1', 'https://example.invalid/index.html?readonly=1'],
  ])('recognizes %s', (_label, url) => {
    expect(readLaunchConfig(url).learnerMode).toBe(true);
  });

  it('trims the bundle URL and normalizes mode casing', () => {
    expect(
      readLaunchConfig('https://example.invalid/index.html?mode=LEARNER&bundle=%20scenes/demo.swarm%20'),
    ).toEqual({ learnerMode: true, bundlePath: 'scenes/demo.swarm' });
  });

  it('does not treat unrelated values as learner mode', () => {
    expect(readLaunchConfig('https://example.invalid/index.html?mode=author&learner=true'))
      .toEqual({ learnerMode: false });
  });

  it('opts the scenario editor frame into scenario authoring', () => {
    expect(
      readLaunchConfig('https://example.invalid/index.html?mode=scenario&bundle=scenes/demo.swarm'),
    ).toEqual({ learnerMode: false, scenarioAuthoring: true, bundlePath: 'scenes/demo.swarm' });
    expect(readLaunchConfig('https://example.invalid/index.html?mode=SCENARIO')).toEqual({
      learnerMode: false,
      scenarioAuthoring: true,
    });
  });

  it('keeps learner and read-only launches out of scenario authoring', () => {
    expect(readLaunchConfig('https://example.invalid/index.html?mode=scenario&learner=1'))
      .toEqual({ learnerMode: true });
    expect(readLaunchConfig('https://example.invalid/index.html?mode=scenario&readonly=1'))
      .toEqual({ learnerMode: true });
    expect(readLaunchConfig('https://example.invalid/index.html?readonly=1')).toEqual({
      learnerMode: true,
    });
    expect(readLaunchConfig('https://example.invalid/index.html')).toEqual({ learnerMode: false });
  });
});
