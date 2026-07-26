# AGENTS.md

本仓库（cloud-copilot）对 AI agent 的约定。

## Issue / PR 双语规范（强制）

创建或编辑 GitHub issue 时（`gh issue create`、`gh issue edit`、API/MCP，或通过本项目的 PreIssue → Create Issue 流程）**必须**：

1. **标题用中文**（专有名词、代码标识符如 `PreIssue`、`server.js`、`SSE` 可保留英文）。
2. **正文先中文、后英文**，固定结构：

   ```markdown
   <中文正文>

   ---

   <details>
   <summary>English version</summary>

   <上述中文的完整英文翻译>

   </details>
   ```

3. 英文部分必须是**完整翻译**而非摘要，小节结构与中文一一对应。
4. 代码块、命令、路径、日志保持原样不翻译。
5. PR 标题/描述、较长的 issue 评论同样遵循“中文在前，英文折叠在后”。

同样的规则也写在 `~/.copilot/copilot-instructions.md`（对所有仓库生效），此文件用于让仓库内的其他 agent（Copilot coding agent、Code Review 等）也能读到。

## 其他

- 部署方式见 `.cloud-copilot.json`（`npm run cc:restart`）。
- 项目说明见 `README.md`。

## Web UI 改动必须跑 UI 验证

本仓库是 web 项目，`.cloud-copilot.json` 里已声明 `ui` 块。改动 `public/*.html`、
CSS 或任何用户可见的界面后，**必须**用 `ui-test` skill 验证：

```bash
PORT=8899 nohup npm start > /tmp/ui-test.log 2>&1 &   # 不要用 cc:restart，会杀掉当前 job
node ~/.agents/skills/ui-test/scripts/audit.mjs --config .cloud-copilot.json --out /tmp/ui-audit
```

error 级别的问题必须修完再提交；结果表格贴进 PR 的 `## UI validation` 小节。
非 web 项目（如 iOS）跳过此步骤。
