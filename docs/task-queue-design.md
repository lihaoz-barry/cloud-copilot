# Task Queue — 设计文档 v2(worktree 隔离版)

> 状态:**待批准**(批准后再开始实施)
> v1 → v2 的核心变化:队列不再和人工动作抢同一份工作树,而是**整体搬进 git worktree**,
> 与主工作树完全隔离。下面 §3 是这一版的立论基础。

---

## 1. 目标

让 cloud-copilot 从「我点一下,它做一件事」变成「我打上 label,它自己排队做完」——
**且完全不打扰我本地那份 checkout**。

1. **自动发现工作** — 定时巡查每个仓库的 GitHub issue,凡是打了指定 label 且还没有 PR 的,自动排队跑 Create PR。
2. **自动跟上 main** — 每天凌晨检查所有 open PR 的分支,落后于 `origin/main` 的自动合并推送;冲突的单独排一个 Copilot 任务去解。
3. **调度器永不触碰主工作树** — 所有排队任务在专属 worktree 里跑,可以带自己的端口起服务做测试。
4. **人工动作永不排队** — Deploy / Merge / PR 对话 / Admin 终端全部保持现状,立即执行,一秒都不等队列。
5. **进度持久化** — 每一步状态落盘。服务器随时崩、随时重启,都知道队列里还剩几个、跑完了几个、哪个被打断了。
6. **可见可插队** — 屏幕左上角图标 + 任务抽屉,支持把某个任务提到最优先。
7. **每日简报** — 每天 08:00 生成过去 24 小时的执行简报,面板可看,可选发邮件。

### 非目标(这一版不做)

- Deploy / Merge / Chat **不动**,继续在主工作树上跑,继续共用现有那把锁。
- 队列任务**只跑到 Create PR 为止**,不自动 Deploy、不自动 Merge。人来把关。
- 不做服务端 Web Push。日报走「面板 + 邮件」。
- 同一仓库不并行跑 Create PR(每仓库一个 worktree,串行)。

---

## 2. 已确认的决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 入队筛选 | 只做**带 label** 的 open issue,默认 `committed` |
| 2 | label 配置 | 独立文件 `data/queue-config.json`,**设置面板可选**,选项从 `gh label list` 实时拉 |
| 3 | 队列粒度 | **每仓库一条队**,仓库之间并行,单仓库内串行 |
| 4 | 隔离方式 | **每仓库一个长期复用的 git worktree**,任务间 reset 清理 |
| 5 | worktree 里跑测试 | **要跑** — 每仓库配 bootstrap 命令 + 静态端口 |
| 6 | 同步 main | 也走 worktree;先纯 `git merge`,**冲突了才叫 Copilot** |
| 7 | 任务深度 | **只到 Create PR** |
| 8 | 同步巡查 | 每天 **03:00**;巡查算 1 个任务,每个待合并分支各 1 个独立任务 |
| 9 | 启停 | **随服务启动自动运行**,进度全部持久化 |
| 10 | 失败策略 | 失败标红**不重试**;被崩溃打断的任务重启后**自动重跑一次** |
| 11 | 新 issue 巡查 | 每 **30 分钟** |
| 12 | 日报 | **08:00** 生成;存服务端 + 面板历史;Resend 发邮件(零依赖) |
| 13 | 仓库默认 | **默认启用**,设置面板可逐个 toggle 关闭 |
| 14 | Deploy 切分支行为 | **这版不改**(见 §11 已知遗留) |

---

## 3. 立论:两个互不相干的世界

这是 v2 与 v1 的根本差别,也是整个设计能成立的原因。

```
╔═══════════════════════════════════╗   ╔═══════════════════════════════════╗
║  交互世界(主工作树)              ║   ║  调度世界(worktree)              ║
║  ~/Repos/<repo>/                  ║   ║  ~/.cloud-copilot/worktrees/<repo>/║
╟───────────────────────────────────╢   ╟───────────────────────────────────╢
║  • Deploy                         ║   ║  • Create PR                      ║
║  • Merge                          ║   ║  • sync-scan / sync-branch        ║
║  • PR / issue 对话                ║   ║  • sync-conflict                  ║
║  • Admin 终端                     ║   ║                                   ║
║  • Restart main                   ║   ║                                   ║
╟───────────────────────────────────╢   ╟───────────────────────────────────╢
║  触发:人点的                     ║   ║  触发:定时器                     ║
║  排队:不排,立即执行             ║   ║  排队:每仓库一条串行队列         ║
║  互斥:现有 findOtherRepoBusyKey  ║   ║  互斥:每仓库一个 worktree        ║
║  代码:一行不改                   ║   ║  端口:每仓库静态分配             ║
╚═══════════════════════════════════╝   ╚═══════════════════════════════════╝
              │                                        │
              └────────── 共用同一个 .git ─────────────┘
                          (远程、对象库、refs)
```

**v1 的问题**:队列 worker 是 `findOtherRepoBusyKey` 那把锁的又一个使用者,于是必须写一整套交织逻辑——队列发现锁被占要退让、人工动作优先、队列跑着时你点 Deploy 会被 Blocked、抢锁的公平性……这些全是纯粹因为共用工作树而凭空长出来的复杂度。

**v2 把这层交织整个删掉。** 两个世界只共用 `.git`(远程、对象库),而 git 本身就是为多 worktree 并发设计的。结果是:

- 现有的锁、现有的 Deploy/Merge/Chat 路由,**一行都不用改**
- 队列的正确性不依赖任何"礼让"约定,只依赖"这个目录只有我在用"
- 两个世界可以各自独立测试

总代码量比 v1 多(多了 worktree 管理器 + bootstrap + 端口,约 +250 行),但**耦合面小得多**。这笔账划算。

---

## 4. worktree 管理

### 4.1 位置

```
~/.cloud-copilot/worktrees/<repo>/
```

**必须放在 `REPOS_ROOT` 外面。** [lib/gh.js:117](../lib/gh.js) 判定一个目录是不是仓库的条件是 `.git` 存在 —— 而 worktree 的 `.git` 是一个**文件**(内容是 `gitdir: ...`),`fs.existsSync` 同样返回 true。放进 `REPOS_ROOT` 的话,你首页会凭空多出一排幽灵仓库。

### 4.2 生命周期

**长期存在,反复复用。** 第一次用到时创建,之后一直留着 —— 这样 `node_modules` / `Pods` 只装一次。

```bash
# 首次创建(懒创建,第一个任务触发)
git -C <repo> worktree add --detach ~/.cloud-copilot/worktrees/<repo> origin/main
<bootstrap 命令>          # npm ci / pod install / cp .env …

# 每个任务开始前(复位)
git fetch origin --prune
git reset --hard
git clean -df             # 注意是 -df 不是 -xdf:保留 ignored 文件,node_modules 活下来
git checkout -B cc/issue-<n> origin/main

# 每个任务结束后(释放分支,见 §4.4)
git checkout --detach origin/main
```

### 4.3 bootstrap:唯一会真正咬人的部分

新 worktree 里**没有** `node_modules`、`Pods`、`.env` —— 这些都是 gitignore 的,`git worktree add` 不会带过来。既然要在 worktree 里起服务做测试,就必须能把它装起来。

`.cloud-copilot.json` 新增一节:

```jsonc
{
  "deploy": { "type": "shell", "command": "npm run cc:restart" },   // 已有,不动
  "worktree": {
    "bootstrap": "npm ci",              // 首次创建后跑一次;为空则跳过
    "refresh": "npm ci",                // 依赖清单变了时重跑;为空则不重跑
    "port": 9101,                       // 这个仓库的 worktree 专用端口
    "copyFiles": [".env"]               // 从主仓库拷过来的 gitignore 文件
  }
}
```

- `bootstrap` 只在 worktree **首次创建**时跑。
- `refresh` 在检测到依赖清单变化时跑(`package-lock.json` / `Podfile.lock` 的 SHA 与上次记录不同)。
- 没有 `worktree` 配置的仓库 → 不 bootstrap、不分配端口,worktree 纯粹当"不干扰你本地的编辑场所"用。iOS 仓库大概率就是这种。

### 4.4 一个必须处理的碰撞:分支所有权

**git 不允许同一个分支在两个 worktree 里同时 checkout。**

现实场景:队列在 worktree 里跑完 `cc/issue-96` 开了 PR → 你在 UI 上点 Deploy → 主工作树要 `git checkout cc/issue-96` → **git 直接拒绝**,因为该分支还被 worktree 占着。

处理:**每个任务结束后,worktree 立刻 `git checkout --detach origin/main`**,交出分支所有权。detached HEAD 不占任何分支名,主工作树想 checkout 哪个分支都行。

这条如果不写,大概第二周就会撞上,而且报错信息("fatal: 'cc/issue-96' is already checked out at ...")离真正的原因很远。

### 4.5 端口

每仓库一个**静态端口**,写在配置里。因为同一仓库同时只有一个 Create PR 在跑,静态分配零冲突 —— 不需要动态端口池那套东西。

端口通过两条路同时告诉 agent:

1. **环境变量** `PORT=<port>` 注入子进程(大多数框架直接认)
2. **写进 prompt**:「你在一个专用 worktree 里,要起服务测试就用端口 `<port>`,不要用 8787 —— 那是主实例在跑」

### 4.6 崩溃与清理

- 服务启动时 `git worktree prune`(清掉目录已被手工删除的登记项)
- worktree 目录不存在 → 下次任务时重建 + 重跑 bootstrap
- worktree 处于冲突/dirty 中间态 → 任务开始前的 `reset --hard` + `clean -df` 自动收拾
- 磁盘:每个启用的仓库多一份 checkout。web 项目几百 MB,iOS 带 Pods 可能几 GB。面板里显示各 worktree 占用,提供「删除 worktree」按钮

---

## 5. 数据模型

### 5.1 队列 `data/queue.json`

**单独一个文件,不进 `state.json`。** `state.json` 已经 ~600KB(装着全部 transcript),队列每几秒写一次进度,塞进去等于每次刷 600KB。队列文件预计 < 50KB。原子写(写 `.tmp` 再 `rename`),沿用 `store.js` 的做法。

```jsonc
{
  "version": 1,
  "tasks": [
    {
      "id": "t_20260731_a3f9",
      "repo": "ios-diet-expert",
      "type": "create-pr",            // create-pr | sync-scan | sync-branch | sync-conflict
      "status": "queued",             // queued|running|success|failed|interrupted|cancelled|skipped
      "priority": 0,                  // 小的先跑;「置顶」设为 -1
      "issueNumber": 96,
      "prNumber": null,
      "branch": "cc/issue-96",        // worktree 里预建的分支
      "title": "#96 支持导出 PDF",
      "jobKey": "ios-diet-expert#96:work",   // 复用现有 key,可点进去看实时日志
      "worktreePath": "/Users/openclaw/.cloud-copilot/worktrees/ios-diet-expert",
      "port": 9101,
      "dedupeKey": "ios-diet-expert#96:create-pr",
      "enqueuedAt": "…", "startedAt": null, "finishedAt": null,
      "durationMs": null, "heartbeatAt": null,
      "attempt": 1,                   // 只有 interrupted 重跑才会变 2
      "error": null,
      "log": null,                    // sync-* 的简短 git 输出
      "spawnedTaskIds": []
    }
  ],
  "history": [ /* 完成超过 24h 的,最多 500 条 */ ],
  "counters": { "ios-diet-expert": { "totalDone": 42, "totalFailed": 3, "lastScanAt": "…" } },
  "cooldown": { "ios-diet-expert#96:create-pr": { "failedAt": "…", "reason": "no PR opened" } },
  "worktrees": {
    "ios-diet-expert": { "path": "…", "createdAt": "…", "bootstrappedAt": "…", "lockfileHash": "…" }
  },
  "lastSyncScanDate": "2026-07-31",
  "lastReportDate": "2026-07-30"
}
```

### 5.2 配置 `data/queue-config.json`

`data/` 已在 `.gitignore` 里,邮件 token 放这儿不会被提交。

```jsonc
{
  "version": 1,
  "enabled": true,
  "scanIntervalMinutes": 30,
  "syncAt": "03:00",
  "reportAt": "08:00",
  "reportRetentionDays": 30,
  "defaultLabels": ["committed"],
  "taskTimeoutMinutes": 60,
  "worktreeRoot": "~/.cloud-copilot/worktrees",
  "email": { "enabled": false, "provider": "resend", "token": "", "from": "", "to": "" },
  "repos": {
    // 只记录被显式改过的仓库;没列出的 = 启用 + defaultLabels
    "cloud-copilot": { "enabled": false, "labels": ["committed"], "paused": false }
  }
}
```

---

## 6. 任务类型与状态机

| type | 触发 | 在哪跑 | 干什么 | 用 Copilot |
|------|------|--------|--------|-----------|
| `create-pr` | 每 30 分巡查 / 手动 | worktree | 实现 issue → commit → push → 开 PR | ✅ |
| `sync-scan` | 每天 03:00 | worktree | `git fetch` + 逐个 PR 判断是否落后,派生子任务 | ❌ 纯 git |
| `sync-branch` | sync-scan 派生 | worktree | checkout → `merge origin/main` → push | ❌ 纯 git |
| `sync-conflict` | sync-branch 派生 | worktree | Copilot 解冲突 → commit → push → git 复核 | ✅ |

```
                  ┌──────────┐
   入队 ─────────▶│  queued  │
                  └────┬─────┘
        worker 取到,占用 worktree
                       ▼
                  ┌──────────┐   判定成功    ┌──────────┐
                  │ running  │─────────────▶│ success  │
                  └────┬─────┘               └──────────┘
      ┌────────────────┼────────────────┬─────────────────────┐
      │ 判定失败        │ 你点了取消      │ 服务器被杀           │
      ▼                ▼                ▼                     │
 ┌──────────┐    ┌───────────┐   ┌─────────────┐              │
 │  failed  │    │ cancelled │   │ interrupted │              │
 └────┬─────┘    └───────────┘   └──────┬──────┘              │
      │ 进 cooldown,不再自动重排         │ attempt<2 → 重新入队 │
      │                                 │ attempt=2 → failed  │
      ▼                                 └─────────────────────┘
 (面板「↻ 重试」可清 cooldown 重排)
```

`skipped`:入队时条件成立,轮到它时不成立了(label 被撤、PR 已被别人开、分支已不落后)。不算失败,不进 cooldown,面板上灰色一行带原因。

---

## 7. 调度器

### 7.1 三个定时器

进程内 `setInterval`,不引入 cron 依赖。

- **issueScan** — 启动后 10 秒一次,之后每 30 分钟;**另外每个仓库队列跑空时立即再扫一次**(刚打完 label 又恰好空闲时不用干等)。
- **syncScan** — 每分钟检查「现在是否已过今天的 03:00 且 `lastSyncScanDate !== 今天`」。这个写法自带**补跑**:Mac 半夜睡着了,醒来第一次检查就补上,而不是整天不跑。
- **dailyReport** — 同样的写法,判断 08:00 + `lastReportDate`。

### 7.2 每仓库一个 worker

```js
async function workerLoop(repo) {
  for (;;) {
    if (!config.repoActive(repo)) { await sleep(5000); continue; }
    const task = queue.nextQueued(repo);
    if (!task) { await sleep(3000); continue; }
    await runTask(task);           // 内部逐步 queue.save()
  }
}
```

注意这里**没有任何抢锁 / 礼让逻辑** —— 那正是 v2 的收益。worker 唯一的排他资源是本仓库的 worktree,而只有它自己会用。

### 7.3 与 `cloud-copilot` 自身的关系

cloud-copilot 也是被扫描的仓库之一。它的 Create PR 在 worktree 里跑、用端口 `9102` 起测试实例,**不会碰到主实例的 8787,也不会触发自重启** —— 因为队列深度只到 Create PR。你手动点 Restart main 时,那属于交互世界,与队列无关。

---

## 8. 各任务执行细节

### 8.1 `create-pr`

1. 备好 worktree(§4.2 复位序列),分支 `cc/issue-<n>`
2. 复用 [server.js](../server.js) 抽出的 `startWorkJob()`,只是 `cwd` 换成 worktree、`env` 注入 `PORT`
3. prompt 相对现有版本加两句:
   - 「你已经在专用 worktree 的分支 `cc/issue-<n>` 上,**不要再新建分支**」
   - 「要起服务测试就用端口 `<port>`」
4. 成功判定、`state.json` 写入**完全沿用现有逻辑** —— 队列跑出来的 PR,在 issue 卡片上的呈现和你手点的一模一样
5. 结束后 `git checkout --detach origin/main` 交出分支(§4.4)

**入队前检查**(任一不满足就不入队):issue 是 open、带配置的 label、没被 dismiss、`gh` 查不到关联 open PR、队列里没有同 issue 的 queued/running、不在 cooldown。
**轮到执行时再查一遍**(期间 label 可能被撤、PR 可能被人开了)→ 不满足则 `skipped`。

### 8.2 `sync-scan`(每天 03:00,每仓库一个)

```bash
git fetch origin --prune
gh pr list --state open --json number,headRefName,title
git rev-list --count origin/<headRef>..origin/main    # >0 即落后
```

全程只读。落后的每个分支派生一个 `sync-branch` 任务。扫描结果写进任务的 `log`,面板里能看到「检查了 7 个 PR,3 个落后」。

### 8.3 `sync-branch`

```bash
git checkout <branch> && git merge origin/main --no-edit
# 成功 → git push → success
# 冲突 → git merge --abort → 派生 sync-conflict 任务 → 本任务 success(附注"已转交冲突任务")
# 其他错误 → git merge --abort(尽力)→ failed
# 结束 → git checkout --detach origin/main
```

**为什么冲突要 abort 再转任务:** 队列串行共用同一个 worktree,绝不能把一个处于冲突中间态的工作树留给下一个任务。代价是那次 merge 白做一遍(几秒),换来的是队列永远不会因为脏工作树而雪崩。

### 8.4 `sync-conflict`

起 Copilot(`--allow-all`),prompt 与 [lib/mergeRunner.js:69](../lib/mergeRunner.js) 的 `recoveryPrompt()` 同源。

判定:**退出码 0 且 `git rev-list --count origin/<branch>..origin/main === 0`**。只信 agent 的自述不够,用 git 复核。

---

## 9. 每日简报

### 9.1 内容(过去 24 小时)

```
📊 cloud-copilot 日报 · 2026-07-31

跑完 8 个任务 · ✅ 6  ❌ 1  ⏭ 1        用时合计 2h14m

ios-diet-expert
  ✅ #96 支持导出 PDF          → PR #131   18m
  ✅ #98 修复设置页崩溃         → PR #132   9m
  ❌ #99 重构网络层            未开出 PR(退出码 1)
  ✅ sync: 3 个分支已跟上 main
  ⏭ #101 label 已撤,跳过

cloud-copilot
  ✅ #44 队列面板              → PR #45    31m

⏳ 队列中还有 3 个待办
⚠️ 需要你看一下:#99(失败,已停在 cooldown,面板可重试)
```

### 9.2 存储与投递

- 写 `data/reports/<date>.json`(结构化)+ `.md`(给人/给别的工具读),保留 30 天
- 面板「日报」页签列历史,点开看全文
- 网页恰好开着时,顺带用现有 [notify.js](../public/notify.js) 弹一条
- **邮件(可选)**:配置里填 token 就发。只实现 **Resend** —— 一个 `fetch` POST 到 `https://api.resend.com/emails`,Node 18 自带 fetch,**零新依赖**。发送失败只记日志,绝不影响队列

---

## 10. API 与 UI

### 10.1 新增端点

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/queue` | 队列 + 计数 + 运行中(面板轮询 3s) |
| `GET` | `/api/queue/summary` | 只返回角标数字(15s 轮询) |
| `POST` | `/api/queue/scan` | 立即巡查一次 |
| `POST` | `/api/queue/tasks` | 手动入队 |
| `DELETE` | `/api/queue/tasks/:id` | 移除 queued 任务 |
| `POST` | `/api/queue/tasks/:id/top` | 置顶 |
| `POST` | `/api/queue/tasks/:id/cancel` | 中止 running(转调 `jobs.cancelJob`) |
| `POST` | `/api/queue/tasks/:id/retry` | 清 cooldown 重排 |
| `POST` | `/api/queue/repos/:name/pause` | 暂停/恢复某仓库队列 |
| `GET`/`PUT` | `/api/queue/config` | 读写配置(token 打码) |
| `GET` | `/api/repos/:name/labels` | `gh label list`,给 label 选择器 |
| `GET` | `/api/queue/worktrees` | worktree 状态 + 磁盘占用 |
| `DELETE` | `/api/queue/worktrees/:name` | 删除并重建 worktree |
| `GET` | `/api/reports` · `/api/reports/:date` · `POST /api/reports/run` | 日报 |

轮询而非 SSE:队列状态是小 JSON,3 秒一次比再维护一条长连接简单。任务的**日志流**仍走现有 job SSE —— 面板里点一个 create-pr 任务直接跳到那个 issue 的日志。

### 10.2 左上角图标 + 抽屉

固定 `top:12px; left:12px`,复用现有 `.depth-fab` / `.depth-drawer` 样式(方向改成左)。

```
┌──────────────┐
│ ⚡ 3         │  空闲=灰无角标 / 运行中=黄+脉冲 / 有失败=红点
└──────────────┘

┌─────────────────────────────────┐
│ 任务队列              [队列|日报] │
│ ─────────────────────────────── │
│ ios-diet-expert  :9101   ⏸ 暂停 │
│  🟡 #96 Create PR    12m  [⨯]   │  ← 点行跳日志
│  🔵 #98 Create PR   排队中 [↑][🗑]│
│  🔵 sync feat-91    排队中       │
│                                 │
│ cloud-copilot    :9102   ⏸ 暂停 │
│  🔴 #99 Create PR  未开出 PR [↻] │
│  ⚪ #101 已跳过(label 已撤)      │
│ ─────────────────────────────── │
│ 今日:✅6 ❌1 ⏭1   [立即巡查]     │
└─────────────────────────────────┘
```

### 10.3 设置面板新增「任务队列」一节

总开关 / 每仓库 toggle + **label 多选**(选项从 `gh label list` 拉,带颜色圆点)/ 巡查间隔 / 同步时间 / 日报时间 / worktree 状态与端口 / 邮件配置 + 「发测试邮件」。

---

## 11. 边界情况与已知遗留

| 情况 | 处理 |
|------|------|
| Copilot 卡住不退 | 每任务超时(默认 60 分),超时即 `cancelJob` + 标 failed |
| 分支被两个 worktree 争用 | 任务结束必 `checkout --detach`,见 §4.4 |
| `.git` 并发争用 | 主树 Deploy 与 worktree 任务同时 fetch,可能撞 `packed-refs.lock`。git 自带重试,失败则任务标 failed 可重试。罕见 |
| worktree 被手工删了 | 启动时 `worktree prune`;下次任务重建 + 重 bootstrap |
| 依赖清单变了 | 比对 lockfile SHA,变了就跑 `refresh` |
| 磁盘吃紧 | 面板显示各 worktree 占用,可单个删除 |
| `gh` 未登录 / 限流 | 巡查失败记一条,不清队列、不进 cooldown,下轮重试 |
| `queue.json` 损坏 | 备份成 `.corrupt-<ts>` 后从空队列启动,面板顶部告警 |
| **Deploy 会把主 checkout 留在 PR 分支上** | **已知,这版不改**([server.js:975](../server.js) 的 `git checkout`)。要"本地永远停在 main",得另开一版 |

---

## 12. 对现有代码的改动面

v2 相对 v1 最大的好处:**几乎不碰现有逻辑。**

| 文件 | 改动 |
|------|------|
| `lib/jobs.js` | 加 `job.finished` Promise;`startJob` 支持 `env` 覆盖。**纯增量** |
| `server.js` | 把 Create PR 的启动逻辑抽成 `startWorkJob(repo, n, {mode, cwd, env})`(行为等价);新增 `/api/queue/*` 等路由;启动时拉起 scheduler |
| **锁相关** (`findOtherRepoBusyKey` / `WORKING_TREE_ACTION_RE` / `manualLocks`) | **一行不改** |
| **Deploy / Merge / Chat 路由** | **一行不改** |
| `public/index.html` | 左上 FAB + 抽屉 + 设置一节 |
| `.cloud-copilot.json` | 新增可选的 `worktree` 节 |

**新增文件:** `lib/queue.js`、`lib/worktree.js`、`lib/scheduler.js`、`lib/queueConfig.js`、`lib/syncTasks.js`、`lib/report.js`、`lib/mailer.js`
**零新 npm 依赖。**

---

## 13. 实施顺序

| 阶段 | 内容 | 可验收的样子 |
|------|------|-------------|
| **P1** | `lib/queue.js` 持久化队列 + 崩溃恢复;`jobs.js` 加 `finished`/`env` | 单测:入队去重、置顶、cooldown、reconcile |
| **P2** | `lib/worktree.js` 创建/复位/bootstrap/detach/prune | 手动对一个仓库建 worktree 并跑通复位序列 |
| **P3** | `lib/scheduler.js` worker 循环 + `create-pr` 任务 | 手动入队一个 issue,能在 worktree 里跑完并开出 PR |
| **P4** | 配置 + labels API + 30 分钟巡查 + `/api/queue/*` | 打上 label 后 30 分钟内自动开跑 |
| **P5** | 左上角图标 + 抽屉 + 设置面板 | 手机上能看能插队能中止 |
| **P6** | 同步三件套(scan / branch / conflict) | 03:00 自动把落后分支跟上 main |
| **P7** | 日报 + 面板页签 + Resend 邮件 | 08:00 收到简报 |

P1–P5 做完就已经完整可用;P6/P7 是增量。

---

## 14. 待确认

无。以上决策均已拍板,等你说开始。
