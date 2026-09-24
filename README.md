# Edit Timeline For Codex

在 VS Code 中按 Codex 回合查看编辑时间线、文件差异，并恢复或撤销恢复。当前版本为 **0.1.1**，仅支持 Windows 本机：项目须在 VS Code 中打开，扩展须保持运行。

## 安装

1. 在 VS Code 扩展市场搜索 **Edit Timeline For Codex**（发布者 `karson1992`）并安装；也可以用“从 VSIX 安装”安装 `edit-timeline-for-codex-0.1.1.vsix`。安装后重新加载窗口。
2. 打开要记录的项目文件夹。多根工作区会分别扫描、关联与显示。
3. 运行命令 **Edit Timeline For Codex: 一键配置 Hook**。扩展会检测 `CODEX_HOME`，否则使用 `%USERPROFILE%\.codex`；在该目录的 `hooks.json` 中幂等加入 `UserPromptSubmit`、`PreToolUse`、`PostToolUse` 三个命令 Hook，保留其他配置并在修改前备份。损坏的配置不会被覆盖。
4. **重新启动 Codex**，输入 `/hooks`，检查并手动信任本插件的三个 Hook，然后发起一次编辑验证。扩展不会写入 Codex 的信任状态。参见[官方 Hook 说明](https://learn.chatgpt.com/docs/hooks)。
5. 运行“检查 Hook 状态”可检查配置和 VS Code Node 运行模式；“查看手动信任说明”可重复查看操作；“移除本插件 Hook”只删除本插件的三个命令。

Hook 桥接脚本使用 VS Code 自带的 Node 运行模式，不要求另装 Node。配置命令会执行运行时自检。Hook 命令通过带随机令牌的 Windows 命名管道与扩展通信；没有工作区文件监听，也没有事件目录轮询。相同工作区的重复窗口只保留一个管道接收端。

## 使用

- 每次 `PostToolUse` 采集实际变化并成功保存后，时间线立即更新；记录显示的是**最后更新时间**，不表示整个任务已结束。
- 提示中的“采集跨度”从首次工具前回调算到最近一次工具后回调，包含采集开销；它不表示整个 Codex 任务的耗时。旧记录没有保存起点，或缺少工具前回调时显示“未记录”。恢复操作不显示采集跨度。
- 点击文件查看修改前后差异；右键恢复文件或整条记录。恢复本身生成一条新记录，恢复该记录可撤销恢复。
- 支持提示词、文件路径、备注搜索，时间筛选、置顶、合并、统计，以及 Markdown、JSON、CSV 导出。
- 没有提示词时显示“未捕获提示词”；没有修改前快照时明确标记原因。不会读取 Codex 日志或以当前内容充当旧内容。
- 手工保存不会生成记录。只有三个受信任的 Hook 输入触发采集。

## 采集与性能

`UserPromptSubmit` 只保存提示词和回合信息。`PreToolUse` 在工具执行前采集；`PostToolUse` 采集执行后状态并提交变化。`apply_patch` 的目标路径可完整解析时只检查这些路径，包括移动的源与目标；其他工具在每次前后扫描工作区，以发现增删文件。扫描、正文读取、哈希、压缩和差异统计在后台 worker 运行。文件读取并发最多 4 个，正文缓存最多 64 MiB，单文件文本快照默认最多 1 MiB，采集预算为 10 秒，Hook 超时为 15 秒。复杂差异统计有 400 万单元格上限。

同一工作区、`session_id`、`turn_id` 归为一条记录；`tool_use_id` 用于配对和去重。同一文件保留回合内首次修改前、最后一次修改后的快照。并发改动无法精确区分时会标注归属不确定。

## 存储和清理

快照按内容哈希去重并保存在 VS Code 的扩展工作区存储目录，与原项目历史隔离；不会自动迁移旧数据。默认总容量 512 MiB，最多保留 500 条未置顶记录和 30 天未置顶历史。置顶记录受保护。容量接近上限时先清理最旧未置顶记录；仍无法保存的变化只记录路径并说明原因。历史变更提交后才清理失去引用的快照；扩展启动后也会延迟校验实际引用次数并清除孤立文件。

在 VS Code 设置中搜索 `editTimelineForCodex` 可调整容量、天数、条数、单文件上限与排除目录。默认排除依赖、构建产物和缓存目录；**锁文件和项目文档默认会记录**。关闭或调整排除项后在下一次 Hook 采集生效。

## 已知限制

- 通用工具首次扫描需要枚举和读取有效文件；大工作区可能达到预算并标记采集不完整。
- 缓存依据文件身份、大小、修改时间和变更时间。极端情况下写入后这些元数据完全保持不变，通用扫描可能漏检；可解析的补丁目标会强制读取。
- 缺少 `PostToolUse` 时不能确认工具结果；工具结束后的后台写入不会被本次 Hook 捕获。Hook 执行期间混入的人工改动也可能进入同一次前后差异，并标记归属不确定。
- 二进制、过大文件和容量不足的文件只保留路径、变化类型及原因，不能可靠比较或恢复。缺少修改前快照时也不能恢复。
- 工作区没有打开、扩展未运行、Hook 尚未信任或超过预算时，不能保证记录完整。

## 开发

`npm run check-types`、`npm run lint`、`npm run test:unit`、`npm run test:integration` 分别运行类型、格式、单元和扩展集成检查。`npm run package` 生成 VSIX。构建与验证记录见 [测试报告](https://github.com/qiukangsong1992-sketch/edit-timeline-for-codex/blob/main/docs/TEST_REPORT.md)。

基于 Rajendra Choudhary 的 AI Changes Timeline 开发，保留其完整 MIT 许可。衍生项目和依赖说明见 [DERIVATION.md](https://github.com/qiukangsong1992-sketch/edit-timeline-for-codex/blob/main/DERIVATION.md)。
