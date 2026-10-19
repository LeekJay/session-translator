export type TranslationLanguage = 'en' | 'zh' | 'ja' | 'fr' | 'de'

export type TranslationCacheEntry =
  | { readonly status: 'translated'; readonly text: string }
  | { readonly status: 'failed'; readonly reason: string }

export type TranslationCache = Record<string, TranslationCacheEntry>

export type OriginalPrompts = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'session-translator': {
      cache: TranslationCache
      originals: OriginalPrompts
    }
  }
}
