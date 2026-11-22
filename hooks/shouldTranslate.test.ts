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
