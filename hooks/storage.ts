import type { EngineInterface } from 'claude-code'
import type {
  OriginalPrompts,
  TranslationCache,
  TranslationCacheEntry,
} from '../types'
import { excessCacheEntryCount, isCacheEntry } from './translate'

export const PERSIST_DELAY_MS = 1000

// 每条译文单独占一个 key：多个会话共用一个 store 时，各自只写自己刚翻的那条，
// 不会像整表回写那样把并发会话写入的条目覆盖掉。
const CACHE_ENTRY_KEY_PREFIX = 'cache-entry:'

// 每条译文再配一个大小标记，字符数直接写进 key 名：
// cache-entry-size:<textLength>:<cacheKey>。会话启动修剪时只列一次 keys()，
// 不用逐条读取译文正文就能按总字符数淘汰。
const CACHE_ENTRY_SIZE_KEY_PREFIX = 'cache-entry-size:'

// 每条原文单独占一个 key：多个会话共用一个 store 时，各自只写自己那条消息，
// 不会像整表回写那样互相覆盖丢数据。
const ORIGINALS_KEY_PREFIX = 'originals:'
const MAX_ORIGINAL_PROMPTS = 2000

// 会话开始时只读取旧版整表 'originals' 键并修剪超出上限的逐条键；
// 逐条键改为在 UserMessage 渲染时按需懒加载，避免启动时批量读取阻塞。
// 旧版本把原文存成一个整表 'originals' 键；升级后仍读它，否则旧会话
// --resume 后原文全部丢失。新格式的逐条键优先级更高。
export const LEGACY_ORIGINALS_KEY = 'originals'
export const LEGACY_CACHE_KEY = 'cache'

export type StorageState = {
  cache: TranslationCache
  legacyOriginals: OriginalPrompts
  readonly loadedOriginals: Map<string, string | null>
  persistScheduled: boolean
  readonly pendingPersist: Map<string, TranslationCacheEntry>
  // 本会话已经成功写进 store 的译文 key，避免每次持久化都重写一遍。
  readonly persistedKeys: Set<string>
  readonly unpersistableKeys: Set<string>
  // 跨会话译文按需读取的结果：命中的条目，或已确认的缺失（null）。
  // 没读过的 key 不在表里；读失败也不记，下次渲染可以重试。
  readonly persistedEntries: Map<string, TranslationCacheEntry | null>
}

export function createStorageState(): StorageState {
  return {
    cache: {},
    legacyOriginals: {},
    loadedOriginals: new Map<string, string | null>(),
    persistScheduled: false,
    pendingPersist: new Map<string, TranslationCacheEntry>(),
    persistedKeys: new Set<string>(),
    unpersistableKeys: new Set<string>(),
    persistedEntries: new Map<string, TranslationCacheEntry | null>(),
  }
}

export function storedOriginalKey(messageId: string): string {
  return `${ORIGINALS_KEY_PREFIX}${messageId}`
}

export function storedCacheEntryKey(entryKey: string): string {
  return `${CACHE_ENTRY_KEY_PREFIX}${entryKey}`
}

export function storedCacheEntrySizeKey(
  entryKey: string,
  textLength: number,
): string {
  return `${CACHE_ENTRY_SIZE_KEY_PREFIX}${textLength}:${entryKey}`
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

type CacheEntrySizeMarker = {
  readonly key: string
  readonly entryKey: string
  readonly textLength: number
}

type CacheEntrySizeIndex = {
  // 同一个条目因并发重写或重试可能有多个标记，按最大值保守计费。
  readonly maxLengthByEntryKey: Map<string, number>
  readonly markersByEntryKey: Map<string, CacheEntrySizeMarker[]>
}

function parseCacheEntrySizeKey(
  key: string,
): CacheEntrySizeMarker | undefined {
  if (!key.startsWith(CACHE_ENTRY_SIZE_KEY_PREFIX)) return undefined

  const rest = key.slice(CACHE_ENTRY_SIZE_KEY_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) return undefined

  const textLength = Number(rest.slice(0, separator))
  const entryKey = rest.slice(separator + 1)
  if (entryKey.length === 0) return undefined
  if (!Number.isSafeInteger(textLength) || textLength < 0) return undefined
  return { key, entryKey, textLength }
}

function indexCacheEntrySizes(keys: readonly string[]): CacheEntrySizeIndex {
  const maxLengthByEntryKey = new Map<string, number>()
  const markersByEntryKey = new Map<string, CacheEntrySizeMarker[]>()

  for (const key of keys) {
    const marker = parseCacheEntrySizeKey(key)
    if (marker === undefined) continue

    const previous = maxLengthByEntryKey.get(marker.entryKey) ?? 0
    maxLengthByEntryKey.set(
      marker.entryKey,
      Math.max(previous, marker.textLength),
    )

    const markers = markersByEntryKey.get(marker.entryKey)
    if (markers === undefined) {
      markersByEntryKey.set(marker.entryKey, [marker])
    } else {
      markers.push(marker)
    }
  }

  return { maxLengthByEntryKey, markersByEntryKey }
}

// 返回需要从 store 删除的 key：超限的最旧译文条目连同它的大小标记一起删。
// 没有大小标记的条目（旧数据/种子）按 0 字符计，但仍受条目数上限约束。
export function excessCacheKeys(keys: readonly string[]): string[] {
  const entryKeys = keys.filter(key => key.startsWith(CACHE_ENTRY_KEY_PREFIX))
  const entryKeySet = new Set(entryKeys)
  const sizes = indexCacheEntrySizes(keys)
  // 标记里嵌的是原始 cacheKey，补上前缀才能和 store 里的正文 key 对上。
  const textLengths = entryKeys.map(key => {
    const entryKey = key.slice(CACHE_ENTRY_KEY_PREFIX.length)
    return sizes.maxLengthByEntryKey.get(entryKey) ?? 0
  })
  const dropCount = excessCacheEntryCount(textLengths)
  const keptEntryKeys = new Set(entryKeys.slice(dropCount))

  const deleteKeys = new Set(entryKeys.slice(0, dropCount))
  if (keys.includes(LEGACY_CACHE_KEY)) {
    deleteKeys.add(LEGACY_CACHE_KEY)
  }
  for (const [entryKey, markers] of sizes.markersByEntryKey) {
    const entryStoreKey = storedCacheEntryKey(entryKey)
    if (!entryKeySet.has(entryStoreKey)) {
      // 正文已不存在（旧版本或中断的删除留下的孤儿标记），顺手清掉。
      for (const marker of markers) deleteKeys.add(marker.key)
      continue
    }
    if (!keptEntryKeys.has(entryStoreKey)) {
      for (const marker of markers) deleteKeys.add(marker.key)
      continue
    }
    // 正文保留时只留表示最大长度的标记，并发重写留下的旧标记一并清理。
    const maxLength = sizes.maxLengthByEntryKey.get(entryKey) ?? 0
    let keptMarker = false
    for (const marker of markers) {
      if (!keptMarker && marker.textLength === maxLength) {
        keptMarker = true
        continue
      }
      deleteKeys.add(marker.key)
    }
  }

  // 按 keys() 的原始顺序返回，每个 key 只删一次。
  return keys.filter(key => deleteKeys.has(key))
}

export async function pruneStoreOnOverflow($: EngineInterface): Promise<void> {
  let keys: readonly string[]
  try {
    keys = await $.store.keys()
  } catch {
    return
  }

  const toDelete = new Set<string>([
    ...excessOriginalKeys(keys),
    ...excessCacheKeys(keys),
  ])

  const remainingOriginals = keys.filter(
    key => key.startsWith(ORIGINALS_KEY_PREFIX) && !toDelete.has(key),
  )
  if (remainingOriginals.length > 0) {
    const count = Math.max(1, Math.ceil(remainingOriginals.length * 0.25))
    for (const key of remainingOriginals.slice(0, count)) {
      toDelete.add(key)
    }
  }

  const remainingCacheEntries = keys.filter(
    key => key.startsWith(CACHE_ENTRY_KEY_PREFIX) && !toDelete.has(key),
  )
  if (remainingCacheEntries.length > 0) {
    const count = Math.max(1, Math.ceil(remainingCacheEntries.length * 0.25))
    const sizes = indexCacheEntrySizes(keys)
    for (const key of remainingCacheEntries.slice(0, count)) {
      toDelete.add(key)
      const entryKey = key.slice(CACHE_ENTRY_KEY_PREFIX.length)
      const markers = sizes.markersByEntryKey.get(entryKey)
      if (markers !== undefined) {
        for (const marker of markers) toDelete.add(marker.key)
      }
    }
  }

  for (const key of toDelete) {
    try {
      await $.store.delete(key)
    } catch {}
  }
}

export function rememberOriginal(
  state: StorageState,
  messageId: string,
  original: string | null,
): void {
  if (
    !state.loadedOriginals.has(messageId) &&
    state.loadedOriginals.size >= MAX_ORIGINAL_PROMPTS
  ) {
    const oldest = state.loadedOriginals.keys().next().value
    if (oldest !== undefined) state.loadedOriginals.delete(oldest)
  }
  state.loadedOriginals.delete(messageId)
  state.loadedOriginals.set(messageId, original)
}

// 新会话开始：本次已写记录和跨会话读取结果都不再代表 store 的现状。
export function resetPersistedCacheState(state: StorageState): void {
  state.persistedKeys.clear()
  state.unpersistableKeys.clear()
  state.persistedEntries.clear()
  state.pendingPersist.clear()
}

// 原子缓存淘汰掉的 key 不会再被持久化遍历，去重集合里留着只会随会话无界增长。
// 每次持久化前裁到只保留当前缓存里还存在的 key；之后重新翻回来的 key 会再写一次。
export function retainPersistedKeys(
  persistedKeys: Set<string>,
  entries: TranslationCache,
): void {
  // Set 允许在遍历时删除当前项，不需要先复制一份。
  for (const key of persistedKeys) {
    if (!Object.hasOwn(entries, key)) persistedKeys.delete(key)
  }
}

// 记住一条按需读取结果，并像原子缓存一样限制条数和译文总字符数：
// 长会话里不能因为每条译文都留一份而无限增长。null（已确认缺失）计 0 字符，
// 但仍占 300 条名额；超限时从 Map 插入顺序最旧的条目开始淘汰。
export function rememberPersistedEntry(
  state: StorageState,
  entryKey: string,
  entry: TranslationCacheEntry | null,
): void {
  state.persistedEntries.delete(entryKey)
  state.persistedEntries.set(entryKey, entry)

  const keys = [...state.persistedEntries.keys()]
  const textLengths = keys.map(key => {
    const saved = state.persistedEntries.get(key)
    if (saved === undefined || saved === null) return 0
    return saved.status === 'translated' ? saved.text.length : 0
  })
  const dropCount = excessCacheEntryCount(textLengths)
  for (const key of keys.slice(0, dropCount)) {
    state.persistedEntries.delete(key)
  }
}

// 按需读取一条跨会话译文。命中或确认缺失后记住结果，渲染路径不会重复读；
// 读 store 抛错不记，留待下次渲染重试。
export async function readPersistedEntry(
  $: EngineInterface,
  state: StorageState,
  entryKey: string,
): Promise<TranslationCacheEntry | undefined> {
  const cached = state.persistedEntries.get(entryKey)
  if (cached !== undefined) return cached ?? undefined

  let saved: unknown
  try {
    saved = await $.store.get(storedCacheEntryKey(entryKey))
  } catch {
    return undefined
  }

  // 失败条目和非法值都按缺失处理：调用方重新翻译，成功后覆盖同一个 key。
  const entry =
    isCacheEntry(saved) && saved.status === 'translated' ? saved : null
  rememberPersistedEntry(state, entryKey, entry)
  return entry ?? undefined
}

// 只在内存缓存里该 key 是失败条目时使用：那次失败之后，另一个会话可能已经
// 成功翻译并写进 store，但 readPersistedEntry 的负缓存会一直返回缺失。
// 清掉负缓存后走正常的按需读取，仍然只接受 translated 条目。
export async function recheckPersistedEntry(
  $: EngineInterface,
  state: StorageState,
  entryKey: string,
): Promise<TranslationCacheEntry | undefined> {
  if (state.persistedEntries.get(entryKey) === null) {
    state.persistedEntries.delete(entryKey)
  }
  return readPersistedEntry($, state, entryKey)
}
