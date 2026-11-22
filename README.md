# session-translator

Claude Code mod。把提示替换成模型语言的译文后提交，把助手回复翻译成你的语言。发给主模型和会话记录里存的都是译文，原文按消息 ID 保存在本机插件存储，宿主支持用户消息渲染钩子时可显示原文；输出只改显示，会话记录保持原文。

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
| `/translator rules <text>` | 设置自定义规则（覆盖原规则，留空清空） |
| `/translator reset` | 恢复默认 |
| `/translator-test` | 打印一次模型原始回复，排查用 |

设置和输入原文映射写入本机插件存储。`/translator reset` 清除覆盖，回到 `plugin.json` 里的选项。

## 行为

- 输入翻译。提示在提交前被替换成模型语言的译文，主模型只看到译文；会话记录里存的也是译文。原文按消息 ID 保存在本机插件存储。插件注册了 `UserMessage` 渲染钩子：Claude Code 2.1.330 的宿主实现会向这个钩子传入消息 ID，插件按 ID 找回原文显示（插件测试覆盖了这条路径）；宿主不调用钩子或本机找不到原文时，界面仍显示译文。`--resume` 和 ↑ 历史同样取决于对应界面是否调用这个钩子。翻译模型仍会收到原文。翻译失败时丢弃这次提交：原文放回输入框并弹出提示，主模型收不到原文；同时写日志。直接读会话文件的工具看到的是译文。
- 输出翻译。助手回复在绘制时翻译，存储的会话记录仍是原文；ctrl+o 看到原文。
- 译文缓存。按设置签名加原文哈希缓存在本机插件存储。内存缓存每次写入后立即按 300 条 / 约 100 万字符裁剪；磁盘缓存只在会话启动时裁剪，所以长会话期间磁盘上可以暂时超过这两个上限。同一会话重绘不调用模型；`--resume` 或新会话里重新打开旧回复也直接复用。改语言、模型或规则会让旧缓存失效。
- 表格。含表格的回复先显示 `翻译中…`，译文到达后整块重绘。超过视口宽度的中文表格会改成列表，避免终端按列裁切宽字符导致滚动错位。
- 选择对话框。`AskUserQuestion` 在 `tool.call` 阶段改写工具入参，问题、标题、说明、选项标签和选项描述都翻成中文，首次会等模型几秒，之后走缓存即时显示。答案在回传给模型前映射回英文：选项标签换回原英文标签，用户手输的中文答案和「其他」自由文本再单独翻成英文，模型始终看到英文。`multiSelect`、预览内容原样保留。
- `/goal` 目标条件。设置目标后，引擎会给模型追加一条「A session-scoped Stop hook is now active with condition: …」的提示行；钩子在写入会话时把引号里的条件换成模型语言的译文，引擎自己的英文文案原样保留。屏幕上那行 `Goal set: …`、底部目标状态条和会话里的命令记录都还是你写的原文。`/goal`（查状态）和 `/goal clear` 没有条件，不触发翻译。
- `/btw` 侧问。在参数里追加输出语言指令，让侧问直接用你的语言回答。

## 要求

- Claude Code 2.1.296 或更新。测试于 2.1.296 和 2.1.303。
- 一个可用的 `$.model.complete` 模型。默认使用 `haiku` 别名。
- 输入翻译时，原文会发送给翻译模型；主模型只收到译文。输出翻译在绘制时进行。翻译会把文本发送给你配置的模型提供方；分享或使用前确认数据边界。

## 开发

```
tsc -p .              # 类型检查（TypeScript 5.9）
claude plugin test .  # 宿主内的插件测试
```

`types/claude-code.d.ts` 是本地 Claude Code 2.1.330 引擎生成的声明副本（首行 `// Written by Claude Code 2.1.330.`），包含 `claude-code`、`claude-code/testing` 和该版本内置工具的入参声明。升级宿主后重新获取：交互式从文件夹加载一次本 mod，引擎会把新版本写到 `.claude-plugin/types/claude-code/index.d.ts`；或从 bundled `plugin-authoring/types/claude-code.d.ts` 复制，再重跑上面两条命令。`.claude-plugin/types/` 由引擎生成、已被 `.gitignore` 忽略，不要手改。

这份副本约 1.1 MB，超过 `claude plugin validate .` 的 1 MiB 单文件读取上限，validator 会跳过模块类型检查并给出提示；完整类型检查以 `tsc -p .` 为准。

## 文件

- `.claude-plugin/plugin.json` 清单与选项
- `.claude-plugin/marketplace.json` 分享用市场清单
- `hooks/register.ts` 钩子入口
- `hooks/translate.ts`、`prompt.ts`、`protect.ts`、`languages.ts`、`tables.ts`、`questions.ts`
- `types/index.d.ts` 状态契约
- `types/claude-code.d.ts` 本地 2.1.330 引擎生成的 API 声明副本
- `hooks/*.test.ts` 测试，用 `claude plugin test .` 运行
