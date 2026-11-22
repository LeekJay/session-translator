import type { OriginalPrompts, TranslationCache } from '../types'
import {
  isTranslationCache,
  mergeCaches,
  persistableCache,
  pruneCache,
} from './translate'

export const CACHE_STORE_KEY = 'cache'
export const PERSIST_DELAY_MS = 1000

// 每条原文单独占一个 key：多个会话共用一个 store 时，各自只写自己那条消息，
// 不会像整表回写那样互相覆盖丢数据。
export const ORIGINALS_KEY_PREFIX = 'originals:'
export const MAX_ORIGINAL_PROMPTS = 2000

// 会话开始时只读取旧版整表 'originals' 键并修剪超出上限的逐条键；
// 逐条键改为在 UserMessage 渲染时按需懒加载，避免启动时批量读取阻塞。
// 旧版本把原文存成一个整表 'originals' 键；升级后仍读它，否则旧会话
// --resume 后原文全部丢失。新格式的逐条键优先级更高。
export const LEGACY_ORIGINALS_KEY = 'originals'

export type StorageState = {
  legacyOriginals: OriginalPrompts
  readonly loadedOriginals: Map<string, string>
  persistScheduled: boolean
  persistedCache: TranslationCache | undefined
}

export function createStorageState(): StorageState {
  return {
    legacyOriginals: {},
    loadedOriginals: new Map<string, string>(),
    persistScheduled: false,
    persistedCache: undefined,
  }
}

export function storedOriginalKey(messageId: string): string {
  return `${ORIGINALS_KEY_PREFIX}${messageId}`
}

export function parseLegacyOriginals(saved: unknown): OriginalPrompts {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return {}
  }
  const out: OriginalPrompts = {}
  for (const [messageId, value] of Object.entries(saved)) {
    if (typeof value === 'string') out[messageId] = value
  }
  return out
}

export function excessOriginalKeys(keys: readonly string[]): string[] {
  const originalKeys = keys.filter(key => key.startsWith(ORIGINALS_KEY_PREFIX))
  // keys() 按插入顺序返回，超出的部分是最旧的，从前面开始删。
  const excess = originalKeys.length - MAX_ORIGINAL_PROMPTS
  return originalKeys.slice(0, Math.max(0, excess))
}

export function rememberOriginal(
  state: StorageState,
  messageId: string,
  original: string,
): void {
  if (state.loadedOriginals.size >= MAX_ORIGINAL_PROMPTS) {
    const oldest = state.loadedOriginals.keys().next().value
    if (oldest !== undefined) state.loadedOriginals.delete(oldest)
  }
  state.loadedOriginals.set(messageId, original)
}

export function resolvePersistedCache(
  state: StorageState,
  saved: unknown,
): TranslationCache {
  // 读成功但为空或格式不对：确实没有可复用缓存，记成空表。
  // 读 store 发生在每条助手消息的渲染路径上，不记住会每次都再读一遍；
  // 空表对 mergeCaches 与恢复逻辑等价。读期间持久化可能已写入结果，
  // 空表不覆盖它。
  state.persistedCache = isTranslationCache(saved)
    ? persistableCache(saved)
    : (state.persistedCache ?? {})
  return state.persistedCache
}

export function mergePersistedCache(
  state: StorageState,
  saved: unknown,
  entries: TranslationCache,
): TranslationCache {
  const latestPersisted = isTranslationCache(saved)
    ? persistableCache(saved)
    : state.persistedCache
  const merged = persistableCache(
    pruneCache(mergeCaches(latestPersisted, entries)),
  )
  state.persistedCache = merged
  return merged
}
