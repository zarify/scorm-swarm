import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateManifest } from '../src/activity-builder/js/export.js';

test('generated manifest omits mastery score and includes six launch files', () => {
  const manifest = generateManifest({
    metadata: { activity_id: 'radio-lab', title: 'Swarm & <relay> ]]> "field"' },
    evaluation: {},
  });
  assert.match(manifest, /identifier="swarm_scorm_radio-lab"/);
  assert.match(manifest, /<organization identifier="swarm_org">/);
  assert.match(manifest, /<item identifier="swarm_item" identifierref="swarm_resource"/);
  assert.equal(manifest.includes('<adlcp:masteryscore>'), false);
  assert.equal((manifest.match(/<file href=/g) ?? []).length, 6);
  for (const path of [
    'index.html',
    'css/style.css',
    'js/app.bundle.js',
    'config/activity_config.json',
    'config/scene.swarm',
    'sim/index.html',
  ]) assert.ok(manifest.includes(`<file href="${path}"/>`));
  assert.ok(manifest.includes('Swarm &amp; &lt;relay&gt; ]]&gt; &quot;field&quot;'));
  assert.equal(manifest.includes(']]>'), false);
});
