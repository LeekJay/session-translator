import { expect, test } from 'claude-code/testing'
import { shouldTranslate } from './translate'

test('英语正文不额外翻译', {}, async () => {
  expect(shouldTranslate('Please refactor the payment module.', 'en', '')).toBe(
    false,
  )
})

test('英语短命令不额外翻译', {}, async () => {
  expect(shouldTranslate('fix this', 'en', '')).toBe(false)
})

test('法语正文翻译成英语', {}, async () => {
  expect(
    shouldTranslate('Bonjour, je veux refactorer le module de paiement.', 'en', ''),
  ).toBe(true)
})

test('带变音符号的德语正文翻译成英语', {}, async () => {
  expect(
    shouldTranslate('Bitte prüfe die Anmeldung für das Modul.', 'en', ''),
  ).toBe(true)
})

test('没有英语功能词的长句按未知语言处理', {}, async () => {
  expect(
    shouldTranslate('Refactoriser le module de paiement pour la production', 'en', ''),
  ).toBe(true)
})

test('中文提示在目标语言为英语时照常翻译', {}, async () => {
  expect(shouldTranslate('请修好登录问题。', 'en', '')).toBe(true)
})

test('目标语言不是英语时英语提示照常翻译', {}, async () => {
  expect(shouldTranslate('Please refactor the payment module.', 'fr', '')).toBe(
    true,
  )
})

test('自定义规则强制翻译', {}, async () => {
  expect(shouldTranslate('Please refactor the payment module.', 'en', '- 保留术语')).toBe(
    true,
  )
})

test('斜杠命令不翻译', {}, async () => {
  expect(shouldTranslate('/goal 修好登录问题', 'en', '')).toBe(false)
})

test('带命名空间的斜杠命令不翻译', {}, async () => {
  expect(
    shouldTranslate('/pstack:poteto-mode 目前 #345 还有哪些没完成?', 'en', ''),
  ).toBe(false)
})

test('冒号连写的命令名也按命令跳过', {}, async () => {
  expect(shouldTranslate('/foo:bar:baz', 'en', '')).toBe(false)
})

test('冒号出现在路径里时照常翻译', {}, async () => {
  expect(
    shouldTranslate('/var/log:2026/app.log 报错了，帮我看看', 'en', ''),
  ).toBe(true)
})

test('以绝对路径开头的提示照常翻译', {}, async () => {
  expect(
    shouldTranslate('/var/log/app.log 报错了，帮我看看', 'en', ''),
  ).toBe(true)
})

test('以路径开头的回复照常翻译', {}, async () => {
  expect(
    shouldTranslate('/api/v1/users 返回 500，帮我排查', 'en', ''),
  ).toBe(true)
})

test('纯 JSON 对象不翻译', {}, async () => {
  expect(
    shouldTranslate('{"name":"Alice","role":"admin"}', 'zh', ''),
  ).toBe(false)
})

test('纯 JSON 数组不翻译', {}, async () => {
  expect(
    shouldTranslate('[\n  {"id": 1},\n  {"id": 2}\n]', 'zh', ''),
  ).toBe(false)
})

test('带中文值的纯 JSON 也不翻译', {}, async () => {
  expect(
    shouldTranslate('{"名字":"爱丽丝","角色":"管理员"}', 'en', ''),
  ).toBe(false)
})

test('JSON 后跟正文时仍按正文翻译', {}, async () => {
  expect(
    shouldTranslate('{"name":"Alice"} is followed by prose', 'zh', ''),
  ).toBe(true)
})

test('自定义规则也不翻译纯 JSON', {}, async () => {
  expect(
    shouldTranslate('{"name":"Alice"}', 'zh', '- 保留术语'),
  ).toBe(false)
})

test('裸代码片段不翻译', {}, async () => {
  const snippet = [
    'const value = await getUser(id)',
    'if (!value) {',
    '  return null',
    '}',
  ].join('\n')
  expect(shouldTranslate(snippet, 'zh', '')).toBe(false)
})

test('带围栏的代码仍随正文翻译', {}, async () => {
  const text = [
    'This explains the change:',
    '```ts',
    'const value = 1',
    'return value',
    '```',
    'Please review it.',
  ].join('\n')
  expect(shouldTranslate(text, 'zh', '')).toBe(true)
})

test('普通正文不会被代码规则误伤', {}, async () => {
  const prose = [
    'if you want, we can ship it;',
    'but the tests still need a pass.',
  ].join('\n')
  expect(shouldTranslate(prose, 'zh', '')).toBe(true)
})

test('自定义规则也不翻译裸代码', {}, async () => {
  const snippet = 'const value = 1\nreturn value'
  expect(shouldTranslate(snippet, 'zh', '- 保留术语')).toBe(false)
})
