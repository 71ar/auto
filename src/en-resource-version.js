const DEFAULT_WAREHOUSE_SETTINGS_URLS = [
  'https://appstatic.mahjongsoul.com/v4/en/resources/warehouseSettings/en-release.json',
  'https://appstaticbk.mahjongsoul.com/v4/en/resources/warehouseSettings/en-release.json'
];

const FETCH_TIMEOUT_MS = 15000;
const DISCOVERY_TIMEOUT_MS = 45000;
const MAX_REDIRECTS = 3;
const MAX_WAREHOUSE_ORIGINS = 8;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_VERSION_BUNDLE_BYTES = 128 * 1024;
const MAX_EXPANDED_BUNDLE_BYTES = 64 * 1024 * 1024;
const VERSION_ASSET_PATH = 'MyAssets/docs_version/version.json';
const OFFICIAL_STATIC_HOSTS = new Set([
  'mahjongsoul.game.yo-star.com',
  'game.mahjongsoul.com',
  'appstatic.mahjongsoul.com',
  'appstaticbk.mahjongsoul.com'
]);

async function resolveEnResourceVersion({
  msResourceVersion,
  resourceVersion,
  discover = discoverEnResourceVersion
} = {}) {
  const primaryOverride = msResourceVersion?.trim();
  const secondaryOverride = resourceVersion?.trim();
  const override = primaryOverride || secondaryOverride;
  if (override) {
    return {
      version: normalizePayloadResourceVersion(override, 'EN_RESOURCE_VERSION_OVERRIDE_INVALID'),
      source: 'override'
    };
  }

  return {
    version: normalizePayloadResourceVersion(
      await discover(),
      'EN_RESOURCE_VERSION_DISCOVERY_INVALID'
    ),
    source: 'automatic'
  };
}

async function discoverEnResourceVersion({
  fetchImpl = fetch,
  warehouseSettingsUrls = DEFAULT_WAREHOUSE_SETTINGS_URLS
} = {}) {
  if (warehouseSettingsUrls.length === 0 || warehouseSettingsUrls.length > 4) {
    throw new Error('EN_WAREHOUSE_SETTINGS_COUNT_INVALID');
  }

  const deadlineAt = Date.now() + DISCOVERY_TIMEOUT_MS;
  let lastError = new Error('EN_WAREHOUSE_SETTINGS_UNAVAILABLE');

  for (const settingsUrl of warehouseSettingsUrls) {
    try {
      const settings = await fetchWarehouseSettings(fetchImpl, settingsUrl, deadlineAt);
      const origins = settings.urls
        .map(entry => ({
          url: typeof entry.url === 'string' ? entry.url.replace(/\/$/u, '') : '',
          priority: typeof entry.Priority === 'number' ? entry.Priority : 0
        }))
        .filter(entry => entry.url.length > 0)
        .sort((left, right) => right.priority - left.priority);

      if (origins.length === 0) throw new Error('EN_WAREHOUSE_ORIGINS_INVALID');
      if (origins.length > MAX_WAREHOUSE_ORIGINS) throw new Error('EN_WAREHOUSE_ORIGINS_TOO_MANY');
      for (const origin of origins) assertOfficialStaticUrl(origin.url);

      for (const origin of origins) {
        try {
          const bundleRoot = `${origin.url}${settings.bundlePath}WebGL/DXT/`;
          const manifest = await fetchBytes(
            fetchImpl,
            `${bundleRoot}bundle_info_so.majset`,
            MAX_MANIFEST_BYTES,
            deadlineAt
          );
          const manifestPayload = extractUnityFsPayload(manifest);
          const versionBundleName = findVersionBundleName(manifestPayload, VERSION_ASSET_PATH);
          const versionBundle = await fetchBytes(
            fetchImpl,
            `${bundleRoot}${versionBundleName}`,
            MAX_VERSION_BUNDLE_BYTES,
            deadlineAt
          );
          const candidates = extractWebglVersionCandidates(extractUnityFsPayload(versionBundle));
          return selectCurrentResourceVersion(candidates);
        } catch (error) {
          lastError = error;
        }
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error('EN_RESOURCE_VERSION_DISCOVERY_FAILED', { cause: lastError });
}

async function fetchWarehouseSettings(fetchImpl, url, deadlineAt) {
  const bytes = await fetchBytes(fetchImpl, url, 64 * 1024, deadlineAt);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('EN_WAREHOUSE_SETTINGS_INVALID_JSON', { cause: error });
  }

  if (
    !isRecord(value) ||
    !Array.isArray(value.urls) ||
    value.bundlePath !== '/v4/en/resources/ab/'
  ) {
    throw new Error('EN_WAREHOUSE_SETTINGS_INVALID_SCHEMA');
  }
  return value;
}

async function fetchBytes(fetchImpl, url, maximumBytes, deadlineAt = Date.now() + FETCH_TIMEOUT_MS) {
  let currentUrl = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertOfficialStaticUrl(currentUrl);
    const remainingMs = Math.min(FETCH_TIMEOUT_MS, deadlineAt - Date.now());
    if (remainingMs <= 0) throw new Error('EN_RESOURCE_VERSION_DISCOVERY_TIMEOUT');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/plain, application/octet-stream;q=0.9, */*;q=0.1'
        },
        cache: 'no-store',
        redirect: 'manual'
      });

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) {
          throw new Error('EN_RESOURCE_VERSION_REDIRECT_INVALID');
        }
        await response.body?.cancel().catch(() => undefined);
        currentUrl = new URL(location, currentUrl).toString();
        assertOfficialStaticUrl(currentUrl);
        continue;
      }

      if (response.url) assertOfficialStaticUrl(response.url);
      if (!response.ok) throw new Error(`EN_RESOURCE_VERSION_HTTP_${response.status}`);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error('EN_RESOURCE_VERSION_RESPONSE_TOO_LARGE');
      }
      const bytes = await readBoundedBody(response, maximumBytes);
      if (bytes.length === 0) throw new Error('EN_RESOURCE_VERSION_EMPTY_RESPONSE');
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('EN_RESOURCE_VERSION_REDIRECT_INVALID');
}

async function readBoundedBody(response, maximumBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.length;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('EN_RESOURCE_VERSION_RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

function assertOfficialStaticUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('EN_RESOURCE_VERSION_SOURCE_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !OFFICIAL_STATIC_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error('EN_RESOURCE_VERSION_SOURCE_NOT_ALLOWED');
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function selectCurrentResourceVersion(candidates) {
  const versions = candidates.map(candidate => normalizeCanonicalResourceVersion(candidate));
  if (versions.length === 0) throw new Error('EN_RESOURCE_VERSION_CANDIDATE_MISSING');
  versions.sort(compareResourceVersions);
  return versions.at(-1);
}

function extractWebglVersionCandidates(payload) {
  const text = payload.toString('utf8');
  const patterns = [
    /\{\s*"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+(?:\.w)?)"\s*,\s*"platform"\s*:\s*"WebGL"\s*\}/gu,
    /\{\s*"platform"\s*:\s*"WebGL"\s*,\s*"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+(?:\.w)?)"\s*\}/gu
  ];
  return patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1]));
}

function extractUnityFsPayload(bundle) {
  const state = { offset: 0 };
  if (readCString(bundle, state) !== 'UnityFS') throw new Error('EN_RESOURCE_VERSION_BUNDLE_INVALID');
  requireBytes(bundle, state.offset, 4);
  state.offset += 4;
  readCString(bundle, state);
  readCString(bundle, state);
  requireBytes(bundle, state.offset, 20);
  const fileSize = Number(bundle.readBigUInt64BE(state.offset));
  state.offset += 8;
  const compressedInfoSize = bundle.readUInt32BE(state.offset);
  state.offset += 4;
  const uncompressedInfoSize = bundle.readUInt32BE(state.offset);
  state.offset += 4;
  const flags = bundle.readUInt32BE(state.offset);
  state.offset += 4;
  if (
    fileSize > bundle.length ||
    compressedInfoSize <= 0 ||
    uncompressedInfoSize <= 0 ||
    uncompressedInfoSize > MAX_EXPANDED_BUNDLE_BYTES
  ) {
    throw new Error('EN_RESOURCE_VERSION_BUNDLE_HEADER_INVALID');
  }

  const infoAtEnd = (flags & 0x80) !== 0;
  const needsPadding = (flags & 0x200) !== 0;
  if (needsPadding) state.offset = align16(state.offset);
  const infoOffset = infoAtEnd ? bundle.length - compressedInfoSize : state.offset;
  requireBytes(bundle, infoOffset, compressedInfoSize);
  const info = decompressUnityBlock(
    bundle.subarray(infoOffset, infoOffset + compressedInfoSize),
    uncompressedInfoSize,
    flags & 0x3f
  );

  requireBytes(info, 16, 4);
  let cursor = 16;
  const blockCount = info.readUInt32BE(cursor);
  cursor += 4;
  if (blockCount <= 0 || blockCount > 100000) {
    throw new Error('EN_RESOURCE_VERSION_BLOCK_COUNT_INVALID');
  }
  const blocks = [];
  let declaredExpandedBytes = 0;
  for (let index = 0; index < blockCount; index += 1) {
    requireBytes(info, cursor, 10);
    const unpacked = info.readUInt32BE(cursor);
    const packed = info.readUInt32BE(cursor + 4);
    const compression = info.readUInt16BE(cursor + 8) & 0x3f;
    cursor += 10;
    if (packed <= 0 || unpacked <= 0) throw new Error('EN_RESOURCE_VERSION_BLOCK_INVALID');
    declaredExpandedBytes += unpacked;
    if (declaredExpandedBytes > MAX_EXPANDED_BUNDLE_BYTES) {
      throw new Error('EN_RESOURCE_VERSION_BUNDLE_EXPANDED_TOO_LARGE');
    }
    blocks.push({ packed, unpacked, compression });
  }

  let dataOffset = infoAtEnd ? state.offset : infoOffset + compressedInfoSize;
  if (!infoAtEnd && needsPadding) dataOffset = align16(dataOffset);
  const parts = [];
  let totalBytes = 0;
  for (const block of blocks) {
    requireBytes(bundle, dataOffset, block.packed);
    const unpacked = decompressUnityBlock(
      bundle.subarray(dataOffset, dataOffset + block.packed),
      block.unpacked,
      block.compression
    );
    totalBytes += unpacked.length;
    if (totalBytes > MAX_EXPANDED_BUNDLE_BYTES) {
      throw new Error('EN_RESOURCE_VERSION_BUNDLE_EXPANDED_TOO_LARGE');
    }
    parts.push(unpacked);
    dataOffset += block.packed;
  }
  return Buffer.concat(parts, totalBytes);
}

function findVersionBundleName(payload, versionAssetPath) {
  const assetPath = Buffer.from(versionAssetPath, 'utf8');
  const assetOffset = payload.indexOf(assetPath);
  if (assetOffset < 4 || payload.readUInt32LE(assetOffset - 4) !== assetPath.length) {
    throw new Error('EN_RESOURCE_VERSION_ASSET_MISSING');
  }
  const ownerOffset = align4(assetOffset + assetPath.length);
  requireBytes(payload, ownerOffset, 4);
  const ownerIndex = payload.readUInt32LE(ownerOffset);

  const objectName = Buffer.from('BundleInfoSO', 'utf8');
  let searchOffset = 0;
  while (searchOffset < payload.length) {
    const nameOffset = payload.indexOf(objectName, searchOffset);
    if (nameOffset < 0) break;
    searchOffset = nameOffset + 1;
    if (nameOffset < 4 || payload.readUInt32LE(nameOffset - 4) !== objectName.length) continue;
    try {
      let cursor = align4(nameOffset + objectName.length);
      requireBytes(payload, cursor, 4);
      const count = payload.readUInt32LE(cursor);
      cursor += 4;
      if (count <= ownerIndex || count > 100000) continue;
      for (let index = 0; index <= ownerIndex; index += 1) {
        requireBytes(payload, cursor, 4);
        const length = payload.readUInt32LE(cursor);
        cursor += 4;
        if (length <= 0 || length > 512) throw new Error('EN_RESOURCE_VERSION_BUNDLE_NAME_INVALID');
        requireBytes(payload, cursor, length);
        const name = payload.toString('utf8', cursor, cursor + length);
        cursor = align4(cursor + length);
        requireBytes(payload, cursor, 4);
        cursor += 4;
        if (index === ownerIndex) {
          if (!/^[A-Za-z0-9_@.$-]+$/u.test(name)) {
            throw new Error('EN_RESOURCE_VERSION_BUNDLE_NAME_INVALID');
          }
          return name;
        }
      }
    } catch {
      // The serialized name can occur more than once; keep looking for the mapped entry.
    }
  }
  throw new Error('EN_RESOURCE_VERSION_BUNDLE_MAPPING_MISSING');
}

function decompressUnityBlock(input, expectedLength, compression) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > MAX_EXPANDED_BUNDLE_BYTES) {
    throw new Error('EN_RESOURCE_VERSION_BUNDLE_EXPANDED_TOO_LARGE');
  }
  if (compression === 0) {
    if (input.length !== expectedLength) throw new Error('EN_RESOURCE_VERSION_RAW_BLOCK_LENGTH_INVALID');
    return input;
  }
  if (compression !== 2 && compression !== 3) {
    throw new Error('EN_RESOURCE_VERSION_COMPRESSION_UNSUPPORTED');
  }

  const output = Buffer.alloc(expectedLength);
  let source = 0;
  let target = 0;
  while (source < input.length && target < expectedLength) {
    const token = input[source++];
    let literalLength = token >>> 4;
    if (literalLength === 15) {
      let next = 255;
      while (next === 255) {
        if (source >= input.length) throw new Error('EN_RESOURCE_VERSION_LZ4_INVALID');
        next = input[source++];
        literalLength += next;
      }
    }
    if (source + literalLength > input.length || target + literalLength > expectedLength) {
      throw new Error('EN_RESOURCE_VERSION_LZ4_INVALID');
    }
    input.copy(output, target, source, source + literalLength);
    source += literalLength;
    target += literalLength;
    if (source >= input.length || target === expectedLength) break;

    requireBytes(input, source, 2);
    const matchOffset = input.readUInt16LE(source);
    source += 2;
    if (matchOffset <= 0 || matchOffset > target) throw new Error('EN_RESOURCE_VERSION_LZ4_INVALID');
    let matchLength = token & 15;
    if (matchLength === 15) {
      let next = 255;
      while (next === 255) {
        if (source >= input.length) throw new Error('EN_RESOURCE_VERSION_LZ4_INVALID');
        next = input[source++];
        matchLength += next;
      }
    }
    matchLength += 4;
    if (target + matchLength > expectedLength) throw new Error('EN_RESOURCE_VERSION_LZ4_INVALID');
    for (let index = 0; index < matchLength; index += 1) {
      output[target] = output[target - matchOffset];
      target += 1;
    }
  }
  if (target !== expectedLength) throw new Error('EN_RESOURCE_VERSION_LZ4_LENGTH_INVALID');
  return output;
}

function normalizeCanonicalResourceVersion(value) {
  const normalized = normalizePayloadResourceVersion(value, 'EN_RESOURCE_VERSION_CANDIDATE_INVALID');
  return `${normalized}.w`;
}

function normalizePayloadResourceVersion(value, errorCode = 'EN_RESOURCE_VERSION_INVALID') {
  const trimmed = String(value || '').trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:\.w)?$/u.test(trimmed)) throw new Error(errorCode);
  return trimmed.replace(/\.w$/u, '');
}

function compareResourceVersions(left, right) {
  const leftParts = left.replace(/\.w$/u, '').split('.').map(Number);
  const rightParts = right.replace(/\.w$/u, '').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function readCString(buffer, state) {
  const end = buffer.indexOf(0, state.offset);
  if (end < 0) throw new Error('EN_RESOURCE_VERSION_BUNDLE_HEADER_INVALID');
  const value = buffer.toString('utf8', state.offset, end);
  state.offset = end + 1;
  return value;
}

function requireBytes(buffer, offset, length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error('EN_RESOURCE_VERSION_BUNDLE_TRUNCATED');
  }
}

function align4(value) {
  return (value + 3) & ~3;
}

function align16(value) {
  return (value + 15) & ~15;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  discoverEnResourceVersion,
  extractUnityFsPayload,
  extractWebglVersionCandidates,
  normalizePayloadResourceVersion,
  resolveEnResourceVersion,
  selectCurrentResourceVersion
};
