const assert = require('node:assert/strict');
const test = require('node:test');

const {
  discoverEnResourceVersion,
  extractWebglVersionCandidates,
  resolveEnResourceVersion,
  selectCurrentResourceVersion
} = require('../src/en-resource-version');

test('selects the newest WebGL gameplay resource version', () => {
  const payload = Buffer.from([
    '{"version":"0.11.252","platform":"WebGL"}',
    '{"version":"0.16.230","platform":"WebGL"}',
    '{"platform":"WebGL","version":"0.16.231.w"}',
    '{"version":"9.9.9","platform":"Android"}'
  ].join('\0'));

  assert.equal(
    selectCurrentResourceVersion(extractWebglVersionCandidates(payload)),
    '0.16.231.w'
  );
});

test('normalizes .w and prefers MS_RESOURCE_VERSION over RESOURCE_VERSION', async () => {
  let discoveryCalls = 0;
  const discover = async () => {
    discoveryCalls += 1;
    return '0.99.999.w';
  };

  assert.deepEqual(
    await resolveEnResourceVersion({
      msResourceVersion: ' 0.16.231.w ',
      resourceVersion: '0.16.230',
      discover
    }),
    { version: '0.16.231', source: 'override' }
  );
  assert.deepEqual(
    await resolveEnResourceVersion({
      msResourceVersion: ' ',
      resourceVersion: '0.16.230.w',
      discover
    }),
    { version: '0.16.230', source: 'override' }
  );
  assert.equal(discoveryCalls, 0);
});

test('discovers the EN resource through official backup warehouse assets', async () => {
  const requests = [];
  const manifest = createUnityBundle(createManifestPayload('version-bundle'));
  const version = createUnityBundle(Buffer.from(
    '{"version":"0.16.230","platform":"WebGL"}\0' +
    '{"version":"0.16.231.w","platform":"WebGL"}'
  ));
  const fetchImpl = async input => {
    const url = String(input);
    requests.push(url);
    if (url.includes('appstatic.mahjongsoul.com/settings')) {
      return new Response('unavailable', { status: 503 });
    }
    if (url.includes('appstaticbk.mahjongsoul.com/settings')) {
      return Response.json({
        urls: [{ url: 'https://appstatic.mahjongsoul.com', Priority: 100 }],
        bundlePath: '/v4/en/resources/ab/'
      });
    }
    if (url.endsWith('bundle_info_so.majset')) {
      return new Response(Uint8Array.from(manifest));
    }
    if (url.endsWith('version-bundle')) {
      return new Response(Uint8Array.from(version));
    }
    return new Response('not found', { status: 404 });
  };

  const discovered = await discoverEnResourceVersion({
    fetchImpl,
    warehouseSettingsUrls: [
      'https://appstatic.mahjongsoul.com/settings.json',
      'https://appstaticbk.mahjongsoul.com/settings.json'
    ]
  });

  assert.equal(discovered, '0.16.231.w');
  assert.deepEqual(
    await resolveEnResourceVersion({ discover: async () => discovered }),
    { version: '0.16.231', source: 'automatic' }
  );
  assert.deepEqual(requests, [
    'https://appstatic.mahjongsoul.com/settings.json',
    'https://appstaticbk.mahjongsoul.com/settings.json',
    'https://appstatic.mahjongsoul.com/v4/en/resources/ab/WebGL/DXT/bundle_info_so.majset',
    'https://appstatic.mahjongsoul.com/v4/en/resources/ab/WebGL/DXT/version-bundle'
  ]);
});

test('fails EN discovery instead of substituting a package version', async () => {
  await assert.rejects(
    resolveEnResourceVersion({
      discover: async () => {
        throw new Error('warehouse unavailable');
      }
    }),
    /warehouse unavailable/
  );
});

test('rejects warehouse origins outside the official HTTPS host allowlist', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({
      urls: [{ url: 'https://untrusted.example/assets', Priority: 1 }],
      bundlePath: '/v4/en/resources/ab/'
    });
  };

  await assert.rejects(
    discoverEnResourceVersion({
      fetchImpl,
      warehouseSettingsUrls: ['https://appstatic.mahjongsoul.com/settings.json']
    }),
    /EN_RESOURCE_VERSION_DISCOVERY_FAILED/
  );
  assert.equal(calls, 1);
});

function createManifestPayload(bundleName) {
  const assetPath = Buffer.from('MyAssets/docs_version/version.json', 'utf8');
  const objectName = Buffer.from('BundleInfoSO', 'utf8');
  const name = Buffer.from(bundleName, 'utf8');
  const chunks = [uint32Le(assetPath.length), assetPath];
  pad4(chunks);
  chunks.push(uint32Le(0), uint32Le(objectName.length), objectName);
  pad4(chunks);
  chunks.push(uint32Le(1), uint32Le(name.length), name);
  pad4(chunks);
  chunks.push(uint32Le(0));
  return Buffer.concat(chunks);
}

function createUnityBundle(payload) {
  const info = Buffer.alloc(30);
  info.writeUInt32BE(1, 16);
  info.writeUInt32BE(payload.length, 20);
  info.writeUInt32BE(payload.length, 24);
  info.writeUInt16BE(0, 28);
  const prefix = Buffer.concat([
    Buffer.from('UnityFS\0', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('fixture\0fixture\0', 'ascii')
  ]);
  const header = Buffer.alloc(20);
  const total = prefix.length + header.length + info.length + payload.length;
  header.writeBigUInt64BE(BigInt(total), 0);
  header.writeUInt32BE(info.length, 8);
  header.writeUInt32BE(info.length, 12);
  return Buffer.concat([prefix, header, info, payload]);
}

function uint32Le(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function pad4(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const padding = (4 - (length % 4)) % 4;
  if (padding > 0) chunks.push(Buffer.alloc(padding));
}
