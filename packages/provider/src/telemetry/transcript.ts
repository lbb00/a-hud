import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWritePrivate,
  ensurePrivateDirectory,
  ensurePrivateFile,
  maybeSweepPrivateFiles,
} from "../io.js";
import { PROVIDER_DEFAULTS } from "./config.js";

const TRANSCRIPT_CACHE_HYGIENE = {
  fileNamePattern: /^[a-f0-9]{24}\.json$/,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxEntries: 100,
  // Avoid racing another actively-rendering session under count pressure.
  preserveYoungerThanMs: 15 * 60 * 1000,
} as const;

export interface TranscriptFileFacts {
  turns: number;
  cacheTtlSeconds: number;
  mtimeSeconds: number;
}

interface TranscriptCache extends TranscriptFileFacts {
  v: 2;
  transcriptPath: string;
  size: number;
  mtimeMs: number;
  ids: string[];
  recentEvidence: number[];
  endedWithNewline: boolean;
  device: number;
  inode: number;
  tailDigest: string;
  /** Internal evidence used by regression tests and performance diagnostics. */
  scanStart: number;
}

export function transcriptTurns(text: string): number {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    collectTurnIds(line, ids);
  }
  return ids.size;
}

export function inferCacheTtl(text: string): number {
  const recent = text.split("\n").slice(-600);
  let sawCacheWrite = false;
  for (const line of recent) {
    try {
      const record = JSON.parse(line);
      const usage = record?.message?.usage;
      if ((usage?.cache_creation_input_tokens || 0) <= 0) continue;
      sawCacheWrite = true;
      if ((usage?.cache_creation?.ephemeral_1h_input_tokens || 0) > 0) {
        return PROVIDER_DEFAULTS.cacheFallbackTtlSeconds;
      }
    } catch {
      // A partial JSONL tail is expected while Claude is appending.
    }
  }
  return sawCacheWrite ? 300 : PROVIDER_DEFAULTS.cacheFallbackTtlSeconds;
}

function collectTurnIds(line: string, ids: Set<string>): void {
  // Sidechain responses are subagent traffic, not main-session turns.
  if (/"isSidechain"\s*:\s*true/.test(line)) return;
  for (const match of line.matchAll(/"id"\s*:\s*"(msg_[A-Za-z0-9_]+)"/g)) {
    ids.add(match[1]);
  }
}

function transcriptCachePath(home: string, transcriptPath: string): string {
  const key = createHash("sha256").update(transcriptPath).digest("hex").slice(0, 24);
  return path.join(home, ".agent-hud", "transcript-cache", `${key}.json`);
}

async function readTranscriptCache(
  filePath: string,
  transcriptPath: string,
): Promise<TranscriptCache | null> {
  try {
    await ensurePrivateFile(filePath);
    const cached = JSON.parse(await fs.readFile(filePath, "utf8")) as TranscriptCache;
    if (
      cached.v !== 2 ||
      cached.transcriptPath !== transcriptPath ||
      !Number.isFinite(cached.turns) ||
      !Number.isFinite(cached.cacheTtlSeconds) ||
      !Number.isFinite(cached.mtimeSeconds) ||
      !Number.isFinite(cached.size) ||
      !Number.isFinite(cached.mtimeMs) ||
      !Array.isArray(cached.ids) ||
      !cached.ids.every((id) => typeof id === "string") ||
      !Array.isArray(cached.recentEvidence) ||
      !cached.recentEvidence.every((item) => item === 0 || item === 1 || item === 2) ||
      cached.endedWithNewline !== true ||
      !Number.isFinite(cached.device) ||
      !Number.isFinite(cached.inode) ||
      typeof cached.tailDigest !== "string"
    ) return null;
    return cached;
  } catch {
    return null;
  }
}

async function writeTranscriptCache(
  filePath: string,
  value: TranscriptCache,
): Promise<void> {
  try {
    await atomicWritePrivate(filePath, JSON.stringify(value));
  } catch {
    // A cache miss is harmless.
  }
}

async function tailDigest(filePath: string, size: number): Promise<string> {
  const length = Math.min(size, 4_096);
  const buffer = Buffer.alloc(length);
  const handle = await fs.open(filePath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}

/**
 * Stream a transcript without retaining JSONL bodies. A stable newline-ended
 * scan persists message IDs and cache evidence, so later renders scan only
 * bytes Claude appended.
 */
export async function readTranscriptFacts(
  transcriptPath: string,
  home: string,
): Promise<TranscriptFileFacts | null> {
  if (!transcriptPath) return null;
  try {
    const stat = await fs.stat(transcriptPath);
    const cachePath = transcriptCachePath(home, transcriptPath);
    const cacheDirectory = path.dirname(cachePath);
    const maintainCache = () => maybeSweepPrivateFiles(
      cacheDirectory,
      TRANSCRIPT_CACHE_HYGIENE,
      { protectedPaths: [cachePath] },
    );
    await ensurePrivateDirectory(cacheDirectory);
    const cached = await readTranscriptCache(cachePath, transcriptPath);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.device === stat.dev &&
      cached.inode === stat.ino
    ) {
      const unchanged = {
        turns: cached.turns,
        cacheTtlSeconds: cached.cacheTtlSeconds,
        mtimeSeconds: cached.mtimeSeconds,
      };
      await maintainCache();
      return unchanged;
    }
    const appendCache = cached &&
      cached.size < stat.size &&
      cached.device === stat.dev &&
      cached.inode === stat.ino &&
      await tailDigest(transcriptPath, cached.size) === cached.tailDigest
      ? cached
      : null;
    const scanStart = appendCache?.size ?? 0;
    const ids = new Set<string>(appendCache?.ids ?? []);
    const evidenceCapacity = 600;
    const recentEvidence = Array.from({ length: evidenceCapacity }, () => 0);
    let recentCount = 0;
    for (const item of appendCache?.recentEvidence ?? []) {
      recentEvidence[recentCount % evidenceCapacity] = item;
      recentCount += 1;
    }
    let overlap = "";
    let lineIds = new Set<string>();
    let lineIsSidechain = false;
    let lineIsAssistant = false;
    let lineHasMessageObject = false;
    let lineHasUsageObject = false;
    let lineSawCacheWrite = false;
    let lineSawOneHourWrite = false;
    let lineTouched = false;
    const scanSegment = (segment: string) => {
      lineTouched ||= segment.length > 0;
      const scan = `${overlap}${segment}`;
      // Require Claude's assistant/message/usage envelope so identically named
      // fields inside user tool results are not treated as cache evidence.
      lineIsAssistant ||= /"type"\s*:\s*"assistant"/.test(scan);
      lineHasMessageObject ||= /"message"\s*:\s*\{/.test(scan);
      lineHasUsageObject ||= lineHasMessageObject && /"usage"\s*:\s*\{/.test(scan);
      const fields =
        /"(id|isSidechain|cache_creation_input_tokens|ephemeral_1h_input_tokens)"\s*:\s*(?:"(msg_[A-Za-z0-9_]+)"|(true)|([0-9]+))/g;
      for (const match of scan.matchAll(fields)) {
        const [, name, messageId, truth, number] = match;
        if (name === "id" && messageId) lineIds.add(messageId);
        if (name === "isSidechain" && truth === "true") lineIsSidechain = true;
        if (name === "cache_creation_input_tokens" && Number(number) > 0) {
          lineSawCacheWrite = true;
        }
        if (name === "ephemeral_1h_input_tokens" && Number(number) > 0) {
          lineSawOneHourWrite = true;
        }
      }
      overlap = scan.slice(-256);
    };
    const finishLine = () => {
      if (!lineIsSidechain) {
        for (const id of lineIds) ids.add(id);
      }
      const lineHasCacheWrite = lineIsAssistant &&
        lineHasMessageObject &&
        lineHasUsageObject &&
        lineSawCacheWrite;
      const lineHasOneHourWrite = lineHasCacheWrite && lineSawOneHourWrite;
      recentEvidence[recentCount % evidenceCapacity] =
        lineHasCacheWrite ? (lineHasOneHourWrite ? 2 : 1) : 0;
      recentCount += 1;
      overlap = "";
      lineIds = new Set<string>();
      lineIsSidechain = false;
      lineIsAssistant = false;
      lineHasMessageObject = false;
      lineHasUsageObject = false;
      lineSawCacheWrite = false;
      lineSawOneHourWrite = false;
      lineTouched = false;
    };
    const orderedEvidence = () => {
      const length = Math.min(recentCount, evidenceCapacity);
      const evidenceStart = recentCount >= evidenceCapacity
        ? recentCount % evidenceCapacity
        : 0;
      return Array.from(
        { length },
        (_, index) => recentEvidence[(evidenceStart + index) % evidenceCapacity],
      );
    };
    const ttlFor = (evidence: number[]) => evidence.includes(2)
      ? PROVIDER_DEFAULTS.cacheFallbackTtlSeconds
      : evidence.includes(1) ? 300 : PROVIDER_DEFAULTS.cacheFallbackTtlSeconds;
    let endedWithNewline = scanStart === stat.size
      ? Boolean(appendCache?.endedWithNewline)
      : stat.size === 0;
    let streamedOffset = scanStart;
    let lastCompleteOffset = scanStart;
    const stream = createReadStream(transcriptPath, {
      encoding: "utf8",
      start: scanStart,
    });
    for await (const chunk of stream) {
      const text = String(chunk);
      if (text) endedWithNewline = text.endsWith("\n");
      let start = 0;
      let completeBytes = 0;
      let newline = text.indexOf("\n", start);
      while (newline >= 0) {
        const segment = text.slice(start, newline);
        scanSegment(segment);
        finishLine();
        completeBytes += Buffer.byteLength(segment, "utf8") + 1;
        start = newline + 1;
        lastCompleteOffset = streamedOffset + completeBytes;
        newline = text.indexOf("\n", start);
      }
      scanSegment(text.slice(start));
      streamedOffset += Buffer.byteLength(text, "utf8");
    }
    const completeIds = [...ids];
    const completeEvidence = orderedEvidence();
    if (lineTouched) finishLine();
    const evidence = orderedEvidence();
    const cacheTtlSeconds = ttlFor(evidence);
    const after = await fs.stat(transcriptPath);
    const result = {
      turns: ids.size,
      cacheTtlSeconds,
      mtimeSeconds: Math.floor(after.mtimeMs / 1_000),
    };
    if (after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
      const cacheSize = endedWithNewline ? after.size : lastCompleteOffset;
      const cacheIds = endedWithNewline ? [...ids] : completeIds;
      const cacheEvidence = endedWithNewline ? evidence : completeEvidence;
      await writeTranscriptCache(cachePath, {
        v: 2,
        transcriptPath,
        size: cacheSize,
        mtimeMs: after.mtimeMs,
        ids: cacheIds,
        recentEvidence: cacheEvidence,
        endedWithNewline: true,
        device: after.dev,
        inode: after.ino,
        tailDigest: await tailDigest(transcriptPath, cacheSize),
        scanStart,
        turns: cacheIds.length,
        cacheTtlSeconds: ttlFor(cacheEvidence),
        mtimeSeconds: result.mtimeSeconds,
      });
    }
    await maintainCache();
    return result;
  } catch {
    return null;
  }
}
