import JSZip from 'jszip';
import { base64ToBytes } from '../../shared/swarm-bundle.js';

const SIMULATOR_MISSING_MESSAGE = 'Simulator build missing — run `npm run vendor:sim && npm run build`';
const MANIFEST_FILES = [
  'index.html',
  'css/style.css',
  'js/app.bundle.js',
  'config/activity_config.json',
  'config/scene.swarm',
  'sim/index.html',
];

export function exportJSON(config, sceneBundleBase64) {
  const payload = {
    ...config,
    ...(typeof sceneBundleBase64 === 'string' ? { scene_bundle_base64: sceneBundleBase64 } : {}),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${config.metadata.activity_id || 'swarm-activity'}.json`);
}

export async function exportSCORM(config, sceneBundleBase64) {
  if (typeof sceneBundleBase64 !== 'string' || sceneBundleBase64.length === 0) {
    throw new Error('Capture a scene or load a .swarm file before exporting SCORM.');
  }

  let simulatorFiles;
  try {
    const response = await fetch('sim-files.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    simulatorFiles = await response.json();
  } catch {
    throw new Error(SIMULATOR_MISSING_MESSAGE);
  }
  if (!Array.isArray(simulatorFiles) || simulatorFiles.length === 0 ||
      simulatorFiles.some((path) => !isSafeSimulatorPath(path))) {
    throw new Error(SIMULATOR_MISSING_MESSAGE);
  }

  const [indexHtml, styleCss, appBundle] = await Promise.all([
    fetchText('../scorm-template/index.html'),
    fetchText('../scorm-template/css/style.css'),
    fetchText('../scorm-template/js/app.bundle.js'),
  ]);
  const zip = new JSZip();
  zip.file('imsmanifest.xml', generateManifest(config));
  zip.file('index.html', indexHtml);
  zip.file('css/style.css', styleCss);
  zip.file('js/app.bundle.js', appBundle);
  zip.file('config/activity_config.json', JSON.stringify(config, null, 2));
  zip.file('config/scene.swarm', base64ToBytes(sceneBundleBase64));

  const fetchedFiles = await Promise.all(simulatorFiles.map(async (path) => {
    let response;
    try {
      response = await fetch(`sim/${path}`);
    } catch (error) {
      throw new Error(`Unable to fetch simulator asset ${path}: ${error.message}`);
    }
    if (!response.ok) throw new Error(`Unable to fetch simulator asset ${path}: HTTP ${response.status}`);
    return [path, await response.arrayBuffer()];
  }));
  for (const [path, content] of fetchedFiles) zip.file(`sim/${path}`, content);

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  downloadBlob(blob, `${config.metadata.activity_id}.zip`);
}

export function generateManifest(config) {
  const activityId = escapeXml(config.metadata.activity_id);
  const title = escapeXml(config.metadata.title || 'Swarm activity');
  const fileEntries = MANIFEST_FILES.map((path) => `      <file href="${path}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="swarm_scorm_${activityId}" version="1.0"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                              http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="swarm_org">
    <organization identifier="swarm_org">
      <title>${title}</title>
      <item identifier="swarm_item" identifierref="swarm_resource" isvisible="true">
        <title>${title}</title>
        <adlcp:masteryscore>${config.evaluation.pass_threshold}</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="swarm_resource" type="webcontent" adlcp:scormtype="sco" href="index.html">
${fileEntries}
    </resource>
  </resources>
</manifest>`;
}

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Unable to load package template ${path}: HTTP ${response.status}`);
  return response.text();
}

function isSafeSimulatorPath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
    !path.includes('\\') && path.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
