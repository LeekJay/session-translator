import type { ModelCompleteResult, PluginOptions } from 'claude-code'
import type { TranslationLanguage } from '../types'
import { isTranslationLanguage } from './languages'

export type Options = {
  readonly translateInput: boolean
  readonly inputLanguage: TranslationLanguage
  readonly translateOutput: boolean
  readonly outputLanguage: TranslationLanguage
  readonly model: string
  readonly translationRules: string
}

export type RuntimeConfig = {
  config: Options
  signature: string
}

const DEFAULTS: Options = {
  translateInput: true,
  inputLanguage: 'en',
  translateOutput: true,
  outputLanguage: 'zh',
  model: 'haiku',
  translationRules: '',
}

// settingsPayload 和 describeSettings 共用的键清单：直接从 DEFAULTS 派生。
// 加新设置时 Options 类型和 DEFAULTS 会先让编译器报错，这里无需再改。
export const SETTING_KEYS = Object.keys(DEFAULTS) as (keyof Options)[]

const USAGE_LINE =
  'usage: /translator [status|on|off|input <en|zh|ja|fr|de>|output <en|zh|ja|fr|de>|model <name>|rules <text>|reset]'

export const TRANSLATOR_TEST_PROMPT =
  'Translate "Hello world" into Simplified Chinese. Return only {"translation":"..."}.'

export const SKIP_COMMAND_ARGS_TRANSLATION: ReadonlySet<string> = new Set([
  'translator',
  'translator-test',
  'btw',
  'rename',
  'model',
  'config',
  'compact',
  'clear',
  'help',
  'resume',
  'cost',
  'status',
  'memory',
  'permissions',
  'login',
  'logout',
  'bug',
  'doctor',
  'init',
  'review',
  'vim',
  'terminal-setup',
  'mcp',
  'agents',
  'hooks',
  'plugin',
  'plugins',
  'theme',
  'export',
  'add-dir',
  'ide',
  'install-github-app',
  'release-notes',
  'upgrade',
  'context',
  'usage',
  'effort',
  'fast',
  'color',
  'copy',
  'diff',
  'plan',
  'tasks',
  'todos',
  'bashes',
  'sandbox',
  'stats',
  'insights',
  'keybindings',
  'voice',
  'remote-control',
  'desktop',
  'mobile',
  'chrome',
  'goal',
  'loop',
  'run',
  'code-review',
  'security-review',
  'statusline',
])

// 机器参数：旗标、数字/时长、路径、key=value。这类 token 翻译任何一个都可能
// 改坏命令语义。只有全部 token 都是机器语法时才判为机器参数；npm、test 这类
// 普通小写单词不算机器 token，交给上面的跳过名单处理。
const MACHINE_ARG_PATTERNS: readonly RegExp[] = [
  /^--?[A-Za-z][\w-]*(?:=\S*)?$/, // -x、--fix、--fix=true
  /^\d+(?:\.\d+)?(?:ms|[smhdw])?$/, // 5、5m、2.5h；3rd 这类序号不算时长
  /^(?:[A-Za-z]:[\\/]|\.{0,2}\/|~[\\/])\S*$/, // /review、./x、../x、C:\x、~/x
  /^[A-Za-z_][\w.-]*=\S*$/, // key=value
]

export function looksLikeMachineArgs(args: string): boolean {
  const tokens = args.match(/\S+/g) ?? []
  if (tokens.length === 0) return false
  return tokens.every(token =>
    MACHINE_ARG_PATTERNS.some(pattern => pattern.test(token)),
  )
}

function booleanOption(
  options: PluginOptions,
  key: string,
  fallback: boolean,
): boolean {
  const value = options[key]
  return typeof value === 'boolean' ? value : fallback
}

function stringOption(
  options: PluginOptions,
  key: string,
  fallback: string,
): string {
  const value = options[key]
  return typeof value === 'string' ? value : fallback
}

function languageOption(
  options: PluginOptions,
  key: string,
  fallback: TranslationLanguage,
): TranslationLanguage {
  const value = options[key]
  return isTranslationLanguage(value) ? value : fallback
}

// 两个入口共用同一份读取/回退逻辑：选项用 DEFAULTS 兜底，存储设置用当前值兜底。
function normalizeOptions(
  source: PluginOptions,
  fallback: Options,
): Options {
  const model = stringOption(source, 'model', fallback.model).trim()
  return {
    translateInput: booleanOption(
      source,
      'translateInput',
      fallback.translateInput,
    ),
    inputLanguage: languageOption(
      source,
      'inputLanguage',
      fallback.inputLanguage,
    ),
    translateOutput: booleanOption(
      source,
      'translateOutput',
      fallback.translateOutput,
    ),
    outputLanguage: languageOption(
      source,
      'outputLanguage',
      fallback.outputLanguage,
    ),
    model: model.length > 0 ? model : fallback.model,
    translationRules: stringOption(
      source,
      'translationRules',
      fallback.translationRules,
    ),
  }
}

export function readOptions(options: PluginOptions): Options {
  return normalizeOptions(options, DEFAULTS)
}

export function applyStoredSettings(
  current: Options,
  saved: unknown,
): Options {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return current
  }

  return normalizeOptions(saved as PluginOptions, current)
}

export function settingsPayload(config: Options): Record<string, unknown> {
  return Object.fromEntries(
    SETTING_KEYS.map(key => [key, config[key]] as const),
  )
}

export function describeSettings(config: Options): string[] {
  return SETTING_KEYS.map(key =>
    key === 'translationRules'
      ? `translationRules=${
          config.translationRules.trim().length > 0
            ? config.translationRules
            : '(empty)'
        }`
      : `${key}=${config[key]}`,
  )
}

export function formatConfigRows(
  rows: readonly { readonly key: string; readonly value: unknown }[],
): string {
  const filtered = rows.filter(row => row.key.startsWith('session-translator.'))
  return filtered.length === 0
    ? 'config rows: none'
    : `config rows:\n${filtered
        .map(row => `${row.key}=${JSON.stringify(row.value)}`)
        .join('\n')}`
}

const HAN = /\p{Script=Han}/u

function usageLine(result: ModelCompleteResult): string {
  return `usage: out=${result.usage.output_tokens}, in=${result.usage.input_tokens}`
}

function failureReason(
  result: Exclude<ModelCompleteResult, { isAnswered: true }>,
): string {
  return result.reason === 'api-error'
    ? `api-error (${result.error}, status=${result.status ?? 'none'})`
    : result.reason
}

export function describeCompletion(
  model: string,
  result: ModelCompleteResult,
): string {
  if (result.isAnswered) {
    return [
      `model: ${model}`,
      `reply: ${result.text}`,
      usageLine(result),
    ].join('\n')
  }
  return [
    `model: ${model}`,
    `reason: ${failureReason(result)}`,
    usageLine(result),
  ].join('\n')
}

export function describeSonnet(result: ModelCompleteResult): string {
  return result.isAnswered
    ? `sonnet: ${result.text}\nsonnet ${usageLine(result)}`
    : `sonnet reason: ${failureReason(result)}\nsonnet ${usageLine(result)}`
}

export function needsSonnet(result: ModelCompleteResult): boolean {
  return !result.isAnswered || !HAN.test(result.text)
}

export type TranslatorCommandAction =
  | { readonly kind: 'status' }
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'update'; readonly next: Options; readonly reply: string }
  | { readonly kind: 'reset'; readonly next: Options; readonly reply: string }

export function parseTranslatorCommand(
  args: string,
  current: Options,
  initialOptions: Options,
): TranslatorCommandAction {
  const trimmed = args.trim()
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  const verb = (match?.[1] ?? 'status').toLowerCase()
  const rest = match?.[2] ?? ''

  if (verb === 'status') {
    return { kind: 'status' }
  }

  if (verb === 'on' || verb === 'off') {
    const enabled = verb === 'on'
    return {
      kind: 'update',
      next: {
        ...current,
        translateInput: enabled,
        translateOutput: enabled,
      },
      reply: `已更新：translateInput=${enabled}, translateOutput=${enabled}`,
    }
  }

  if (verb === 'input' || verb === 'output') {
    const language = rest.trim()
    if (!isTranslationLanguage(language)) {
      return { kind: 'reply', text: USAGE_LINE }
    }
    return {
      kind: 'update',
      next:
        verb === 'input'
          ? { ...current, inputLanguage: language }
          : { ...current, outputLanguage: language },
      reply: `已更新：${verb}Language=${language}`,
    }
  }

  if (verb === 'model') {
    const model = rest.trim()
    if (model.length === 0) return { kind: 'reply', text: USAGE_LINE }
    return {
      kind: 'update',
      next: { ...current, model },
      reply: `已更新：model=${model}`,
    }
  }

  if (verb === 'rules') {
    const translationRules = rest.trim()
    return {
      kind: 'update',
      next: { ...current, translationRules },
      reply:
        translationRules.length === 0
          ? '已清空：translationRules'
          : `已更新：translationRules=${translationRules}`,
    }
  }

  if (verb === 'reset') {
    const next: Options = { ...initialOptions }
    return {
      kind: 'reset',
      next,
      reply: `已重置：${describeSettings(next).join('，')}`,
    }
  }

  return { kind: 'reply', text: USAGE_LINE }
}
