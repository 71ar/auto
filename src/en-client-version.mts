import { createHash } from "node:crypto";

const DEFAULT_WAREHOUSE_SETTINGS_URLS = [
  "https://appstatic.mahjongsoul.com/v4/en/resources/warehouseSettings/en-release.json",
  "https://appstaticbk.mahjongsoul.com/v4/en/resources/warehouseSettings/en-release.json"
] as const;

const FETCH_TIMEOUT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 3;
const MAX_WAREHOUSE_ORIGINS = 8;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_VERSION_BUNDLE_BYTES = 128 * 1024;
const MAX_EXPANDED_BUNDLE_BYTES = 64 * 1024 * 1024;
const VERSION_ASSET_PATH = "MyAssets/docs_version/version.json";
const OFFICIAL_STATIC_HOSTS = new Set([
  "mahjongsoul.game.yo-star.com",
  "game.mahjongsoul.com",
  "appstatic.mahjongsoul.com",
  "appstaticbk.mahjongsoul.com"
]);

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface WarehouseSettings {
  readonly urls: readonly { readonly url?: unknown; readonly Priority?: unknown }[];
  readonly bundlePath: string;
}

export interface EnClientVersionResolution {
  readonly version: string;
  readonly source: "override" | "automatic";
}

export interface RegionClientVersionResolution {
  readonly version: string;
  readonly source: "override" | "automatic";
}

export interface WarehouseClientVersionOptions {
  readonly fetchImpl?: FetchLike;
  readonly warehouseSettingsUrls: readonly string[];
  readonly bundlePathPattern: RegExp;
  readonly platformPath: string;
  readonly versionAssetPath: string;
  readonly appendWSuffix: boolean;
  readonly requireWebglPlatform: boolean;
  readonly regionCode: "EN" | "JP";
  readonly onEvidence?: (evidence: OfficialVersionEvidence) => void;
}

export interface OfficialVersionEvidence {
  readonly source: "WAREHOUSE_PRIMARY" | "WAREHOUSE_BACKUP" | "RESOURCE_MANIFEST" | "RESOURCE_VERSION_BUNDLE" | "PACKAGE_PAGE";
  readonly sha256: string;
}

export async function resolveRegionClientVersion(options: {
  readonly regionCode: "EN" | "JP";
  readonly override?: string;
  readonly discover: () => Promise<string>;
  readonly appendWSuffix?: boolean;
}): Promise<RegionClientVersionResolution> {
  const appendWSuffix = options.appendWSuffix ?? true;
  const override = options.override?.trim();
  if (override) {
    return {
      version: normalizeResourceVersion(override, `MAJSOUL_${options.regionCode}_CLIENT_VERSION_INVALID`, appendWSuffix),
      source: "override"
    };
  }
  const discovered = await options.discover();
  return {
    version: normalizeResourceVersion(discovered, `${options.regionCode}_CLIENT_VERSION_DISCOVERY_INVALID`, appendWSuffix),
    source: "automatic"
  };
}

export async function resolveEnClientVersion(options: {
  readonly override?: string;
  readonly discover?: () => Promise<string>;
} = {}): Promise<EnClientVersionResolution> {
  const override = options.override?.trim();
  if (override) {
    return { version: normalizeResourceVersion(override, "MAJSOUL_EN_CLIENT_VERSION_INVALID"), source: "override" };
  }
  const discovered = await (options.discover ?? discoverEnClientVersion)();
  return {
    version: normalizeResourceVersion(discovered, "EN_CLIENT_VERSION_DISCOVERY_INVALID"),
    source: "automatic"
  };
}

export async function discoverEnClientVersion(options: {
  readonly fetchImpl?: FetchLike;
  readonly warehouseSettingsUrls?: readonly string[];
} = {}): Promise<string> {
  return await discoverWarehouseClientVersion({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    warehouseSettingsUrls: options.warehouseSettingsUrls ?? DEFAULT_WAREHOUSE_SETTINGS_URLS,
    bundlePathPattern: /^\/v4\/en\/resources\/ab\/$/u,
    platformPath: "WebGL/DXT/",
    versionAssetPath: VERSION_ASSET_PATH,
    appendWSuffix: true,
    requireWebglPlatform: true,
    regionCode: "EN"
  });
}

export async function discoverWarehouseClientVersion(options: WarehouseClientVersionOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const settingsUrls = options.warehouseSettingsUrls;
  if (settingsUrls.length === 0 || settingsUrls.length > 4) {
    throw new Error(`${options.regionCode}_WAREHOUSE_SETTINGS_COUNT_INVALID`);
  }
  const deadlineAt = Date.now() + DISCOVERY_TIMEOUT_MS;
  let lastError: unknown = new Error(`${options.regionCode}_WAREHOUSE_SETTINGS_UNAVAILABLE`);

  for (const [settingsIndex, settingsUrl] of settingsUrls.entries()) {
    try {
      const settings = await fetchWarehouseSettings(
        fetchImpl,
        settingsUrl,
        options.bundlePathPattern,
        options.regionCode,
        options.onEvidence,
        settingsIndex === 0 ? "WAREHOUSE_PRIMARY" : "WAREHOUSE_BACKUP",
        deadlineAt
      );
      const origins = settings.urls
        .map((entry) => ({
          url: typeof entry.url === "string" ? entry.url.replace(/\/$/u, "") : "",
          priority: typeof entry.Priority === "number" ? entry.Priority : 0
        }))
        .filter((entry) => entry.url.length > 0)
        .sort((left, right) => right.priority - left.priority);
      if (origins.length === 0) throw new Error("EN_WAREHOUSE_ORIGINS_INVALID");
      if (origins.length > MAX_WAREHOUSE_ORIGINS) throw new Error("EN_WAREHOUSE_ORIGINS_TOO_MANY");
      for (const origin of origins) assertOfficialStaticUrl(origin.url, options.regionCode);

      for (const origin of origins) {
        try {
          const bundleRoot = `${origin.url}${settings.bundlePath}${options.platformPath}`;
          const manifest = await fetchBytes(
            fetchImpl,
            `${bundleRoot}bundle_info_so.majset`,
            MAX_MANIFEST_BYTES,
            options.regionCode,
            options.onEvidence,
            "RESOURCE_MANIFEST",
            deadlineAt
          );
          const manifestPayload = extractUnityFsPayload(manifest);
          const versionBundleName = findVersionBundleName(manifestPayload, options.versionAssetPath);
          const versionBundle = await fetchBytes(
            fetchImpl,
            `${bundleRoot}${versionBundleName}`,
            MAX_VERSION_BUNDLE_BYTES,
            options.regionCode,
            options.onEvidence,
            "RESOURCE_VERSION_BUNDLE",
            deadlineAt
          );
          const payload = extractUnityFsPayload(versionBundle);
          const candidates = options.requireWebglPlatform
            ? extractWebglVersionCandidates(payload)
            : extractVersionCandidates(payload);
          return selectCurrentResourceVersion(candidates, options.appendWSuffix);
        } catch (error) {
          lastError = error;
        }
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`${options.regionCode}_CLIENT_VERSION_DISCOVERY_FAILED`, { cause: lastError });
}

export async function discoverUnityPackageVersion(options: {
  readonly pageUrl: string;
  readonly loaderPrefix: string;
  readonly fetchImpl?: FetchLike;
  readonly regionCode: "EN" | "JP";
  readonly onEvidence?: (evidence: OfficialVersionEvidence) => void;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bytes = await fetchBytes(
    fetchImpl,
    options.pageUrl,
    2 * 1024 * 1024,
    options.regionCode,
    options.onEvidence,
    "PACKAGE_PAGE"
  );
  const escaped = options.loaderPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...bytes.toString("utf8").matchAll(new RegExp(`${escaped}-WebGL-release-([0-9]+\\.[0-9]+\\.[0-9]+)\\([0-9]+\\)\\.loader\\.js`, "gu"))];
  const versions = matches.map((match) => match[1]!).sort(comparePackageVersions);
  const version = versions.at(-1);
  if (!version) throw new Error(`${options.regionCode}_PACKAGE_VERSION_DISCOVERY_FAILED`);
  return version;
}

export function selectCurrentResourceVersion(candidates: readonly string[], appendWSuffix = true): string {
  const versions = candidates.map((candidate) => normalizeResourceVersion(candidate, "EN_CLIENT_VERSION_CANDIDATE_INVALID", appendWSuffix));
  if (versions.length === 0) throw new Error("EN_CLIENT_VERSION_CANDIDATE_MISSING");
  versions.sort(compareResourceVersions);
  return versions.at(-1)!;
}

export function extractVersionCandidates(payload: Buffer): string[] {
  const text = payload.toString("utf8");
  return [...text.matchAll(/\{\s*"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+(?:\.w)?)"\s*\}/gu)]
    .map((match) => match[1]!);
}

export function extractWebglVersionCandidates(payload: Buffer): string[] {
  const text = payload.toString("utf8");
  const patterns = [
    /\{\s*"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+(?:\.w)?)"\s*,\s*"platform"\s*:\s*"WebGL"\s*\}/gu,
    /\{\s*"platform"\s*:\s*"WebGL"\s*,\s*"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+(?:\.w)?)"\s*\}/gu
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!));
}

async function fetchWarehouseSettings(
  fetchImpl: FetchLike,
  url: string,
  bundlePathPattern: RegExp,
  regionCode: "EN" | "JP",
  onEvidence?: (evidence: OfficialVersionEvidence) => void,
  evidenceSource: OfficialVersionEvidence["source"] = "WAREHOUSE_PRIMARY",
  deadlineAt?: number
): Promise<WarehouseSettings> {
  const bytes = await fetchBytes(fetchImpl, url, 64 * 1024, regionCode, onEvidence, evidenceSource, deadlineAt);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${regionCode}_WAREHOUSE_SETTINGS_INVALID_JSON`, { cause: error });
  }
  if (!isRecord(value) || !Array.isArray(value.urls) || typeof value.bundlePath !== "string"
    || !bundlePathPattern.test(value.bundlePath)) {
    throw new Error(`${regionCode}_WAREHOUSE_SETTINGS_INVALID_SCHEMA`);
  }
  return value as unknown as WarehouseSettings;
}

async function fetchBytes(
  fetchImpl: FetchLike,
  url: string,
  maximumBytes: number,
  regionCode: "EN" | "JP" = "EN",
  onEvidence?: (evidence: OfficialVersionEvidence) => void,
  evidenceSource?: OfficialVersionEvidence["source"],
  deadlineAt = Date.now() + FETCH_TIMEOUT_MS
): Promise<Buffer> {
  let currentUrl = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertOfficialStaticUrl(currentUrl, regionCode);
    const remainingMs = Math.min(FETCH_TIMEOUT_MS, deadlineAt - Date.now());
    if (remainingMs <= 0) throw new Error(`${regionCode}_CLIENT_VERSION_DISCOVERY_TIMEOUT`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        headers: { accept: "application/json, text/plain, application/octet-stream;q=0.9, */*;q=0.1" },
        cache: "no-store",
        redirect: "manual"
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) throw new Error(`${regionCode}_CLIENT_VERSION_REDIRECT_INVALID`);
        await response.body?.cancel().catch(() => undefined);
        currentUrl = new URL(location, currentUrl).toString();
        assertOfficialStaticUrl(currentUrl, regionCode);
        continue;
      }
      if (response.url) assertOfficialStaticUrl(response.url, regionCode);
      if (!response.ok) throw new Error(`${regionCode}_CLIENT_VERSION_HTTP_${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error("EN_CLIENT_VERSION_RESPONSE_TOO_LARGE");
      }
      const bytes = await readBoundedBody(response, maximumBytes);
      if (bytes.length === 0) throw new Error("EN_CLIENT_VERSION_EMPTY_RESPONSE");
      if (bytes.length > maximumBytes) throw new Error("EN_CLIENT_VERSION_RESPONSE_TOO_LARGE");
      if (onEvidence && evidenceSource) {
        onEvidence({ source: evidenceSource, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${regionCode}_CLIENT_VERSION_REDIRECT_INVALID`);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.length;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("EN_CLIENT_VERSION_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

function assertOfficialStaticUrl(value: string, regionCode: "EN" | "JP"): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${regionCode}_CLIENT_VERSION_SOURCE_INVALID`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !OFFICIAL_STATIC_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`${regionCode}_CLIENT_VERSION_SOURCE_NOT_ALLOWED`);
  }
}

function comparePackageVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function extractUnityFsPayload(bundle: Buffer): Buffer {
  const state = { offset: 0 };
  const signature = readCString(bundle, state);
  if (signature !== "UnityFS") throw new Error("EN_CLIENT_VERSION_BUNDLE_INVALID");
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
  if (fileSize > bundle.length || compressedInfoSize <= 0 || uncompressedInfoSize <= 0
    || uncompressedInfoSize > MAX_EXPANDED_BUNDLE_BYTES) {
    throw new Error("EN_CLIENT_VERSION_BUNDLE_HEADER_INVALID");
  }

  const infoAtEnd = (flags & 0x80) !== 0;
  const needsPadding = (flags & 0x200) !== 0;
  if (needsPadding) state.offset = align16(state.offset);
  const infoOffset = infoAtEnd ? bundle.length - compressedInfoSize : state.offset;
  requireBytes(bundle, infoOffset, compressedInfoSize);
  const compressedInfo = bundle.subarray(infoOffset, infoOffset + compressedInfoSize);
  const info = decompressUnityBlock(compressedInfo, uncompressedInfoSize, flags & 0x3f);

  requireBytes(info, 16, 4);
  let cursor = 16;
  const blockCount = info.readUInt32BE(cursor);
  cursor += 4;
  if (blockCount <= 0 || blockCount > 100_000) throw new Error("EN_CLIENT_VERSION_BLOCK_COUNT_INVALID");
  const blocks: Array<{ packed: number; unpacked: number; compression: number }> = [];
  let declaredExpandedBytes = 0;
  for (let index = 0; index < blockCount; index += 1) {
    requireBytes(info, cursor, 10);
    const unpacked = info.readUInt32BE(cursor);
    const packed = info.readUInt32BE(cursor + 4);
    const compression = info.readUInt16BE(cursor + 8) & 0x3f;
    cursor += 10;
    if (packed <= 0 || unpacked <= 0) throw new Error("EN_CLIENT_VERSION_BLOCK_INVALID");
    declaredExpandedBytes += unpacked;
    if (declaredExpandedBytes > MAX_EXPANDED_BUNDLE_BYTES) {
      throw new Error("EN_CLIENT_VERSION_BUNDLE_EXPANDED_TOO_LARGE");
    }
    blocks.push({ packed, unpacked, compression });
  }

  let dataOffset = infoAtEnd ? state.offset : infoOffset + compressedInfoSize;
  if (!infoAtEnd && needsPadding) dataOffset = align16(dataOffset);
  const parts: Buffer[] = [];
  let totalBytes = 0;
  for (const block of blocks) {
    requireBytes(bundle, dataOffset, block.packed);
    const packed = bundle.subarray(dataOffset, dataOffset + block.packed);
    const unpacked = decompressUnityBlock(packed, block.unpacked, block.compression);
    totalBytes += unpacked.length;
    if (totalBytes > MAX_EXPANDED_BUNDLE_BYTES) throw new Error("EN_CLIENT_VERSION_BUNDLE_EXPANDED_TOO_LARGE");
    parts.push(unpacked);
    dataOffset += block.packed;
  }
  return Buffer.concat(parts, totalBytes);
}

export function findVersionBundleName(payload: Buffer, versionAssetPath: string): string {
  const assetPath = Buffer.from(versionAssetPath, "utf8");
  const assetOffset = payload.indexOf(assetPath);
  if (assetOffset < 4 || payload.readUInt32LE(assetOffset - 4) !== assetPath.length) {
    throw new Error("EN_CLIENT_VERSION_ASSET_MISSING");
  }
  const ownerOffset = align4(assetOffset + assetPath.length);
  requireBytes(payload, ownerOffset, 4);
  const ownerIndex = payload.readUInt32LE(ownerOffset);

  const objectName = Buffer.from("BundleInfoSO", "utf8");
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
      if (count <= ownerIndex || count > 100_000) continue;
      for (let index = 0; index <= ownerIndex; index += 1) {
        requireBytes(payload, cursor, 4);
        const length = payload.readUInt32LE(cursor);
        cursor += 4;
        if (length <= 0 || length > 512) throw new Error("EN_CLIENT_VERSION_BUNDLE_NAME_INVALID");
        requireBytes(payload, cursor, length);
        const name = payload.toString("utf8", cursor, cursor + length);
        cursor = align4(cursor + length);
        requireBytes(payload, cursor, 4);
        cursor += 4;
        if (index === ownerIndex) {
          if (!/^[A-Za-z0-9_@.$-]+$/u.test(name)) throw new Error("EN_CLIENT_VERSION_BUNDLE_NAME_INVALID");
          return name;
        }
      }
    } catch {
      // The script name can occur more than once. Continue until the serialized instance is found.
    }
  }
  throw new Error("EN_CLIENT_VERSION_BUNDLE_MAPPING_MISSING");
}

function decompressUnityBlock(input: Buffer, expectedLength: number, compression: number): Buffer {
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > MAX_EXPANDED_BUNDLE_BYTES) {
    throw new Error("EN_CLIENT_VERSION_BUNDLE_EXPANDED_TOO_LARGE");
  }
  if (compression === 0) {
    if (input.length !== expectedLength) throw new Error("EN_CLIENT_VERSION_RAW_BLOCK_LENGTH_INVALID");
    return input;
  }
  if (compression !== 2 && compression !== 3) throw new Error("EN_CLIENT_VERSION_COMPRESSION_UNSUPPORTED");
  const output = Buffer.alloc(expectedLength);
  let source = 0;
  let target = 0;
  while (source < input.length && target < expectedLength) {
    const token = input[source++]!;
    let literalLength = token >>> 4;
    if (literalLength === 15) {
      let next = 255;
      while (next === 255) {
        if (source >= input.length) throw new Error("EN_CLIENT_VERSION_LZ4_INVALID");
        next = input[source++]!;
        literalLength += next;
      }
    }
    if (source + literalLength > input.length || target + literalLength > expectedLength) {
      throw new Error("EN_CLIENT_VERSION_LZ4_INVALID");
    }
    input.copy(output, target, source, source + literalLength);
    source += literalLength;
    target += literalLength;
    if (source >= input.length || target === expectedLength) break;
    requireBytes(input, source, 2);
    const matchOffset = input.readUInt16LE(source);
    source += 2;
    if (matchOffset <= 0 || matchOffset > target) throw new Error("EN_CLIENT_VERSION_LZ4_INVALID");
    let matchLength = token & 15;
    if (matchLength === 15) {
      let next = 255;
      while (next === 255) {
        if (source >= input.length) throw new Error("EN_CLIENT_VERSION_LZ4_INVALID");
        next = input[source++]!;
        matchLength += next;
      }
    }
    matchLength += 4;
    if (target + matchLength > expectedLength) throw new Error("EN_CLIENT_VERSION_LZ4_INVALID");
    for (let index = 0; index < matchLength; index += 1) {
      output[target] = output[target - matchOffset]!;
      target += 1;
    }
  }
  if (target !== expectedLength) throw new Error("EN_CLIENT_VERSION_LZ4_LENGTH_INVALID");
  return output;
}

function normalizeResourceVersion(value: string, errorCode: string, appendWSuffix = true): string {
  const trimmed = value.trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:\.w)?$/u.test(trimmed)) throw new Error(errorCode);
  if (appendWSuffix) return trimmed.endsWith(".w") ? trimmed : `${trimmed}.w`;
  return trimmed.replace(/\.w$/u, "");
}

function compareResourceVersions(left: string, right: string): number {
  const leftParts = left.replace(/\.w$/u, "").split(".").map(Number);
  const rightParts = right.replace(/\.w$/u, "").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function readCString(buffer: Buffer, state: { offset: number }): string {
  const end = buffer.indexOf(0, state.offset);
  if (end < 0) throw new Error("EN_CLIENT_VERSION_BUNDLE_HEADER_INVALID");
  const value = buffer.toString("utf8", state.offset, end);
  state.offset = end + 1;
  return value;
}

function requireBytes(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error("EN_CLIENT_VERSION_BUNDLE_TRUNCATED");
  }
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function align16(value: number): number {
  return (value + 15) & ~15;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
