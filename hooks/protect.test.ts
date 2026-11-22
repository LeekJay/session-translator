import { expect, test } from 'claude-code/testing'
import { hasTranslatableProse, protectText, restoreText } from './protect'

type ProtectionCase = {
  readonly name: string
  readonly text: string
  readonly fragment: string
  readonly protectedText: string
}

const CASES: readonly ProtectionCase[] = [
  {
    name: '代码围栏',
    text: '先看这段：\n```ts\nconst n = 1\n```\n然后继续。',
    fragment: '```ts\nconst n = 1\n```',
    protectedText: '先看这段：\n@@ST_KEEP_1@@\n然后继续。',
  },
  {
    name: '行内代码',
    text: '运行 `npm test` 看看。',
    fragment: '`npm test`',
    protectedText: '运行 @@ST_KEEP_1@@ 看看。',
  },
  {
    name: 'HTML 标签',
    text: '点击 <button class="primary"> 按钮。',
    fragment: '<button class="primary">',
    protectedText: '点击 @@ST_KEEP_1@@ 按钮。',
  },
  {
    name: '双花括号占位符',
    text: '保留 {{user.name}} 不变。',
    fragment: '{{user.name}}',
    protectedText: '保留 @@ST_KEEP_1@@ 不变。',
  },
  {
    name: '美元花括号占位符',
    text: '保留 ${userName} 不变。',
    fragment: '${userName}',
    protectedText: '保留 @@ST_KEEP_1@@ 不变。',
  },
  {
    name: 'URL',
    text: '见 https://example.com/docs?q=1 说明。',
    fragment: 'https://example.com/docs?q=1',
    protectedText: '见 @@ST_KEEP_1@@ 说明。',
  },
  {
    name: 'Windows 路径',
    text: '打开 C:\\Temp\\app.log 查看。',
    fragment: 'C:\\Temp\\app.log',
    protectedText: '打开 @@ST_KEEP_1@@ 查看。',
  },
  {
    name: 'Unix 绝对路径',
    text: '配置在 /etc/nginx/nginx.conf 里。',
    fragment: '/etc/nginx/nginx.conf',
    protectedText: '配置在 @@ST_KEEP_1@@ 里。',
  },
  {
    name: 'Unix 相对路径',
    text: '改 ./src/index.ts 文件。',
    fragment: './src/index.ts',
    protectedText: '改 @@ST_KEEP_1@@ 文件。',
  },
  {
    name: 'snake_case 标识符',
    text: '把 user_name 传进去。',
    fragment: 'user_name',
    protectedText: '把 @@ST_KEEP_1@@ 传进去。',
  },
  {
    name: 'camelCase 标识符',
    text: '调用 getUserName 方法。',
    fragment: 'getUserName',
    protectedText: '调用 @@ST_KEEP_1@@ 方法。',
  },
  {
    name: 'PascalCase 标识符',
    text: '新建 HttpClient 实例。',
    fragment: 'HttpClient',
    protectedText: '新建 @@ST_KEEP_1@@ 实例。',
  },
  {
    name: 'dotted 标识符',
    text: '读取 app.config.value 的值。',
    fragment: 'app.config.value',
    protectedText: '读取 @@ST_KEEP_1@@ 的值。',
  },
  {
    name: '十六进制串',
    text: '提交 abc1234f 哈希。',
    fragment: 'abc1234f',
    protectedText: '提交 @@ST_KEEP_1@@ 哈希。',
  },
]

for (const entry of CASES) {
  test(`${entry.name}变成占位符并能逐字还原`, {}, async () => {
    const protectedText = protectText(entry.text)

    expect(protectedText.text).toBe(entry.protectedText)
    expect(protectedText.text).not.toContain(entry.fragment)
    expect(protectedText.values).toEqual([entry.fragment])
    expect(restoreText(protectedText.text, protectedText.values)).toBe(
      entry.text,
    )
  })
}

test('多个片段按从左到右的顺序编号并逐字还原', {}, async () => {
  const text =
    '把 user_name 和 C:\\Temp\\app.log 交给 app.run，说明见 https://example.com/docs 结束。'
  const protectedText = protectText(text)

  expect(protectedText.text).toBe(
    '把 @@ST_KEEP_1@@ 和 @@ST_KEEP_2@@ 交给 @@ST_KEEP_3@@，说明见 @@ST_KEEP_4@@ 结束。',
  )
  expect(protectedText.values).toEqual([
    'user_name',
    'C:\\Temp\\app.log',
    'app.run',
    'https://example.com/docs',
  ])
  expect(restoreText(protectedText.text, protectedText.values)).toBe(text)
})

test('代码块与行内代码里的嵌套片段合并为单个占位符', {}, async () => {
  const fenced =
    '```bash\ncurl https://example.com/api --output C:\\Temp\\out.bin\n```'
  const inline = '`cat /etc/hosts`'
  const text = `先执行 ${fenced}，再运行 ${inline}，最后说明。`
  const protectedText = protectText(text)

  expect(protectedText.text).toBe(
    '先执行 @@ST_KEEP_1@@，再运行 @@ST_KEEP_2@@，最后说明。',
  )
  expect(protectedText.values).toEqual([fenced, inline])
  expect(protectedText.text.match(/@@ST_KEEP_\d+@@/g)).toEqual([
    '@@ST_KEEP_1@@',
    '@@ST_KEEP_2@@',
  ])
  expect(restoreText(protectedText.text, protectedText.values)).toBe(text)
})

test('纯受保护片段没有可翻译正文', {}, async () => {
  const inputs = [
    '```js\nconst a = 1\n```',
    '`npm test`',
    'https://example.com/docs',
    'C:\\Temp\\app.log',
    '/etc/hosts',
    'user_name',
  ]

  for (const input of inputs) {
    expect(hasTranslatableProse(protectText(input).text)).toBe(false)
  }
})

test('普通文字与受保护片段并存时仍有可翻译正文', {}, async () => {
  const inputs = [
    '请运行 `npm test`',
    '文档在 https://example.com/docs',
    '把 user_name 换成新名字',
  ]

  for (const input of inputs) {
    expect(hasTranslatableProse(protectText(input).text)).toBe(true)
  }
})
