# 入门

> 适用于 v0.11.x mainline。v0.5-substrate 方法论分支与校准 release 见根 [`README.md`](../README.md)。

5 步走完你的第一节课。

## 1. 安装

```powershell
git clone https://github.com/machinohataki-sys/hypha.git
cd hypha
npm install
```

需要 Node ≥ 18。Windows / macOS / Linux 都行。

打包版本：`npm run pack:win`（或 `:mac` / `:linux`），输出到 `release/`。

## 2. 启动

```powershell
npm start
```

首次启动会询问：

- **vault 路径** — 你的笔记和课程存哪里（默认 `~/Hypha-vault`）
- **LLM provider** — Anthropic / GLM / DeepSeek / Kimi 任选；填 API key

key 存在本机 `vault/data/settings.json`，不发送到任何服务器。

## 3. 写下你的目标

打开"新建课程"。三件事要填：

- **主题**：你想学的领域。例：`Rust 异步运行时`
- **目标**：学完之后能做什么。例：`读懂 tokio 源码，能解释 reactor 与 executor 分工`
- **资料**（可选）：PDF / Markdown / 网页 URL。Hypha 会按章节抽取，作为 grounding 源

按"评估"。Goal Feasibility Guardian 会算时间地板，给一个 absurd / strained / feasible 判断（实现见 `app/lib/feasibility.js`）。

## 4. 链 + 第一节课

可行的目标会进入 Chain Plan：Hypha 把目标拆成 5–9 节课的序列，每节有 prerequisite 与 STAKE。

点第一节，进入 LessonChat。讲义会按 4 阶段生成（hook → 主体 → Feynman 测试 → confession），中途可以打断追问。

讲完点 `/finish`：Hypha 写一份双层笔记到 `vault/<slug>/lesson-01.md`（课程基础在上，你的灵感在下），并出一份退场仪式选项（Track A 做产品 / Track B 讲给真人 / 直接结束）。

## 5. 考、长、回看

- **Exam Dashboard** — 错题归到 8 类（误读 / 跳步 / 张冠李戴 …），考前 7 天会给 5 任务压缩计划
- **Growth** — 同概念在 2 节课以上出现时，Hypha 提示你这是一根 project spine
- **Notes** — 旧笔记半年没动会触发 Living Note Reactivation，问你"还作数吗"

## 常见坑

| 现象 | 解法 |
|---|---|
| 启动后 LLM call 报 "Connection error" | PowerShell `>>` 把 `\n` 烤进了 API key 环境变量。重设并重启进程，见 `CLAUDE.md` Provider 段 |
| 课程卡在 "正在生成讲义" | 检查 `vault/<slug>/lesson-N.body.json` 是否存在；缺则手动重跑 |
| cost 超预算 | Cashflow Shield 在 `app/lib/cashflow-shield/` 设了 Pro ¥5/d / BYOK ¥999/d 闸门；在 设置 → 成本预算 调 |
| vault 路径换了 | 设置 → vault path，重启应用 |

## 终端模式

不喜欢 Electron 也行：

```powershell
npm run cli
```

走 `bin/hypha-cli.js`，共享同一个 vault。
