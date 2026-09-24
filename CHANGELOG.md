# 更新记录

## 0.1.0

- 创建独立的 Edit Timeline For Codex 扩展，使用 `editTimelineForCodex.*` 命令、设置和独立存储。
- 仅通过 `UserPromptSubmit`、`PreToolUse`、`PostToolUse` 三个受信任 Hook 采集 Windows 本机工作区变化。
- 保留时间线、差异、恢复与撤销恢复、搜索、置顶、合并、统计和导出，并提供中文界面。
- 使用后台 worker 执行扫描、哈希、压缩与差异统计；加入容量、条数和天数保留设置。
