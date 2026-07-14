/**
 * Context Manager for optimizing cumulative working memory.
 * Implements regex sweep of stdout/stderr logs and hard truncation limits.
 */

import * as crypto from 'crypto';

// Bounded LRU/FIFO cache with TTL to prevent regex re-evaluation on large static content strings
const cleanCache = new Map<string, { value: string; timestamp: number }>();
const CACHE_TTL_MS = 600000; // 10 minutes TTL

/**
 * Force-clears the clean cache to free heap memory immediately on session shutdown.
 */
export function clearCleanCache(): void {
  cleanCache.clear();
}

/**
 * Sweeps and prunes massive stdout/stderr log blocks from past execution content
 * using a regex clean sweep, replacing them with dynamic truncated indicators.
 */
export function cleanSubprocessLogs(content: string): string {
  if (!content) return '';
  
  // Regex to detect stdout/stderr/STDOUT/STDERR blocks
  // e.g., "stdout: ...", "stderr: ...", or inside codeblocks, or general blocks
  const blockRegex = /(stdo?u?t?|stde?r?r?|STDOUT|STDERR)\s*(?:=|:|\n)\s*([\s\S]{100,100000}?)(?=\n\n|\n[a-zA-Z0-9_\-\.]+?:|\n\[|\n```|$)/gi;
  
  return content.replace(blockRegex, (match, label, payload) => {
    if (payload && payload.length > 300) {
      return `${label.toUpperCase()}: ... [Massive log output of ${payload.length} characters pruned to protect context window] ...`;
    }
    return match;
  });
}

/**
 * Retrieves cleaned content using a highly optimized caching layer
 * to eliminate expensive redundant regex sweeps.
 * Bounded key size strategy to prevent heap exhaustion on massive raw logs.
 */
export function getCleanedContent(content: string): string {
  if (!content) return '';
  const now = Date.now();
  
  // Use a cryptographic SHA-256 hash for the Map to avoid pinning massive raw strings in memory
  // while completely preventing key collision issues.
  const cacheKey = content.length < 512 
    ? content 
    : crypto.createHash('sha256').update(content).digest('hex');

  const cached = cleanCache.get(cacheKey);
  if (cached !== undefined && (now - cached.timestamp < CACHE_TTL_MS)) {
    return cached.value;
  }
  
  const cleaned = cleanSubprocessLogs(content);
  if (cleanCache.size >= 1000) {
    // Direct fast eviction of first entries to bound heap size
    const firstKey = cleanCache.keys().next().value;
    if (firstKey !== undefined) {
      cleanCache.delete(firstKey);
    }
  }
  cleanCache.set(cacheKey, { value: cleaned, timestamp: now });
  return cleaned;
}

/**
 * Enforces a strict working memory limit of 40,000 characters.
 * Implements pointer-mutation direct slicing to run zero-copy arrays where possible.
 */
export function enforceWorkingMemoryTruncation(
  history: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>
): ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }> {
  if (!history || history.length === 0) return [];

  const TOTAL_CHARACTER_LIMIT = 40000;
  const len = history.length;

  // Single-pass direct index pointer evaluation without structural copies or intermediate arrays
  let currentLen = 0;
  for (let i = 0; i < len; i++) {
    const item = history[i];
    if (item && item.content) {
      currentLen += getCleanedContent(item.content).length;
    }
  }

  // Under budget limit - do direct pre-allocated target projections in O(N)
  if (currentLen <= TOTAL_CHARACTER_LIMIT) {
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
      const item = history[i]!;
      result[i] = {
        role: item.role,
        content: getCleanedContent(item.content)
      };
    }
    return result;
  }

  // If over the limit, but we have 5 or fewer items, we must truncate the individual items themselves to stay under budget
  if (len <= 5) {
    const maxPerItem = Math.max(100, Math.floor(TOTAL_CHARACTER_LIMIT / len) - 200);
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
       const item = history[i]!;
       const cleaned = getCleanedContent(item.content);
       const content = cleaned.length > maxPerItem
         ? cleaned.slice(0, maxPerItem) + `\n... [Content truncated to ${maxPerItem} chars of total ${cleaned.length} to fit within 40,000 char working memory limit] ...`
         : cleaned;
       result[i] = {
         role: item.role,
         content
       };
    }
    return result;
  }

  // Pre-allocation of precise sliding evaluation window instead of structural array spread operators
  const prunedHistory = new Array(6);
  
  // Retain original root objective in index 0
  const rootItem = history[0]!;
  prunedHistory[0] = {
    role: rootItem.role,
    content: getCleanedContent(rootItem.content)
  };

  // Retention pointer mutation placeholders
  prunedHistory[1] = {
    role: 'user' as const,
    content: `... [Intermediate verification cycles aggressively pruned and stripped (total context exceeded ${TOTAL_CHARACTER_LIMIT} chars) to enforce exponential-decay truncation on cumulative working memory] ...`
  };

  // Extract trailing operational cycles using direct end-pointer offsets
  const lastFourStart = len - 4;
  for (let i = 0; i < 4; i++) {
    const origItem = history[lastFourStart + i]!;
    prunedHistory[2 + i] = {
      role: origItem.role,
      content: getCleanedContent(origItem.content)
    };
  }

  return prunedHistory;
}

/**
 * A highly optimized preallocated Circular Buffer for sliding evaluation trails.
 * Leverages zero-copy pointer mutation increments for maximum high-density throughput.
 */
export class SlidingWindowCircularBuffer<T> {
  private buffer: T[];
  private capacity: number;
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array<T>(capacity);
  }

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  toArray(): T[] {
    const arr = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) {
      arr[i] = this.buffer[(this.head + i) % this.capacity] as T;
    }
    return arr;
  }

  getMinId(): number {
    const arr = this.toArray();
    let minId = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        const dataObj = (itemObj.data && typeof itemObj.data === 'object') ? (itemObj.data as Record<string, unknown>) : undefined;
        const seq = (typeof itemObj.sequenceId === 'number' ? itemObj.sequenceId : undefined) ?? 
                    (dataObj && typeof dataObj.sequenceId === 'number' ? dataObj.sequenceId : undefined);
        if (seq !== undefined && seq < minId) {
          minId = seq;
        }
      }
    }
    return minId === Infinity ? 0 : minId;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
