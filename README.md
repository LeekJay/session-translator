# session-translator

Claude Code mod。把提示翻译成模型语言，把助手回复翻译成你的语言。只改显示，不改存储的会话记录。

## 安装

GitHub：

```
/plugin install session-translator --marketplace LeekJay/session-translator
```

自建 Git（Gitea 等）：

```
/plugin marketplace add <git-url>
/plugin install session-translator@session-translator
```

回答 `y` 添加市场，作用域选 user，之后每个新会话都会加载。已打开的会话可以用 `/reload-plugins` 立即生效。

## 用法

| 命令 | 作用 |
| --- | --- |
| `/translator status` | 查看当前设置 |
| `/translator on` / `off` | 打开或关闭翻译 |
| `/translator input <en\|zh\|ja\|fr\|de>` | 设置模型语言 |
| `/translator output <en\|zh\|ja\|fr\|de>` | 设置显示语言 |
| `/translator model <name>` | 设置翻译模型 |
| `/translator rules <text>` | 追加自定义规则，每行一条 |
| `/translator reset` | 恢复默认 |
| `/translator-test` | 打印一次模型原始回复，排查用 |

设置写入本机插件存储。`/translator reset` 清除覆盖，回到 `plugin.json` 里的选项。

## 行为

- 输入翻译。提示原样进入会话，历史、Rewind 和会话记录都是原文；英文译文作为模型专用 context 附带，不显示。
- 输出翻译。助手回复在绘制时翻译，存储的会话记录仍是原文；ctrl+o 看到原文。
- 译文缓存。按设置签名加原文哈希缓存在本机插件存储，上限 300 条。同一会话重绘不调用模型；`--resume` 或新会话里重新打开旧回复也直接复用。改语言、模型或规则会让旧缓存失效。
- 表格。含表格的回复先显示 `翻译中…`，译文到达后整块重绘。超过视口宽度的中文表格会改成列表，避免终端按列裁切宽字符导致滚动错位。
- 选择对话框。`AskUserQuestion` 在 `tool.call` 阶段改写工具入参，问题、标题、说明、选项标签和选项描述都翻成中文，首次会等模型几秒，之后走缓存即时显示。答案在回传给模型前映射回英文：选项标签换回原英文标签，用户手输的中文答案和「其他」自由文本再单独翻成英文，模型始终看到英文。`multiSelect`、预览内容原样保留。
- `/goal` 输出行。`Goal set:` / `Goal active:` / `Goal cleared:` 这类英文前缀在绘制时换成中文，条件本身保持用户原文。改的是画面上那一行，会话记录和模型读到的仍是英文。
- `/btw` 侧问。在参数里追加输出语言指令，让侧问直接用你的语言回答。

## 要求

- Claude Code 2.1.296 或更新。测试于 2.1.296 和 2.1.303。
- 一个可用的 `$.model.complete` 模型。默认使用 `haiku` 别名。
- 翻译会把文本发送给你配置的模型提供方。分享或使用前确认数据边界。

## 文件

- `.claude-plugin/plugin.json` 清单与选项
- `.claude-plugin/marketplace.json` 分享用市场清单
- `hooks/register.ts` 钩子入口
- `hooks/translate.ts`、`prompt.ts`、`protect.ts`、`languages.ts`、`tables.ts`、`questions.ts`
- `types/index.d.ts` 状态契约
- `hooks/*.test.ts` 测试，用 `claude plugin test .` 运行
