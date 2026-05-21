# HYPHA v1.0 Operator Handoff

状态: 代码 ready · 56 smoke 全过 (standalone) · 操作步骤待执行 · v0.11.2 → v1.0.0 待 tag

> 此文档 = 给执行者的最短路径. 详细 audit + ship-readiness 矩阵见 `docs/V1_RELEASE_CHECKLIST.md`. 本文档 = 那份 checklist §8 的操作伴侣, 不重复内容, 只给具体每步可复制的命令 + 已知坑.

---

## 必做 (Blocking)

### 1. 安装依赖
```bash
cd E:\victor\hypha
npm install
```
关键包: `electron-builder@^25.1.8`, `electron-updater@^6.3.9`, `sharp@^0.34.5` (icon 生成需要).

验证: `npm run smoke:all` 期望 52/56 PASS (4 sweep-race artifact 已知; 见 §"已知坑 A"). 4 个标记 FAIL 的需 standalone 单跑确认:
```bash
node app/scripts/_dev_verify_creation_system.js
node app/scripts/_dev_verify_full_chain.js
node app/scripts/_dev_verify_golden_path_e2e.js
node app/scripts/_dev_verify_route_goal.js
```
全 PASS 才能 ship.

### 2. 版本号 bump
`package.json` line 3: `"version": "0.11.2"` → `"1.0.0"`. 提交一个 commit `chore: bump v1.0.0`.

### 3. 清掉残留 placeholder 字串
注意: 大多数 placeholder 已替换为真值. 只剩 2 处需手动决策:

- `.github/CODEOWNERS` line 5 注释 `PLACEHOLDER_USERNAME` — 实际规则 (line 10/14/15/16) 已用 `@machinohataki-sys`, 注释文字保留还是删随意, **不影响 CI**.
- `build/README.md` line 95-104 §"Publishing — placeholders" 仍写 `PLACEHOLDER_OWNER / PLACEHOLDER_REPO` 作为示例 — 与 `package.json` 实际值矛盾. 建议把示例代码块改成 "see `package.json` `build.publish[0]` for actual values" 或直接删该段.

如果 repo 转移到 org, 全局替换 `machinohataki-sys` 为新 owner/team:
- `package.json` line 8, 10, 12, 103, 104
- `.github/CODEOWNERS` line 10, 14-16
- `CHANGELOG.md` line 120-121

### 4. 签名 (生产 ship 必需)
跳过签名能 ship, 但用户首次启动会看到 "Unknown Publisher" 警告 (Windows SmartScreen) / "无法验证开发者" (macOS Gatekeeper). 功能正常, 体验受损.

- **Windows**: EV cert (~$200-400/yr from Sectigo/DigiCert). 配 `CSC_LINK` (pfx 路径或 base64) + `CSC_KEY_PASSWORD`.
- **macOS**: Apple Developer ID ($99/yr) + notarization. 配 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
- **Linux AppImage**: 不签.

详见 `build/README.md` §"Signing — not configured here".

### 5. CI Secrets
GitHub repo → Settings → Secrets and variables → Actions, 加:

| Secret | 用途 | 没有时行为 |
|---|---|---|
| `GH_TOKEN` | release 上传产物 | publish job 整段 skip (有 `if: secrets.GH_TOKEN != ''` 守护) |
| `CSC_LINK` + `CSC_KEY_PASSWORD` | Windows 签名 | Windows 构建产出未签名 .exe |
| `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | macOS notarization | mac 构建产出未公证 .dmg |

所有 workflow 在 `.github/workflows/release.yml` 已 `if:` 守护, 没 secret 也不报错, 只 skip.

---

## 可做 (Nice to Have)

### A. icon.icns 重生 (可选)
当前 `build/icon.icns` 已 ship (boot-10 用 `build/generate-icns-from-png.js` 从 `icon.png` 生成多分辨率). 如果设计师交付真 1024×1024 PNG, 替换 `build/icon.png` 后重跑:
```bash
node build/generate-icns-from-png.js --force
```
不做也能 ship.

### B. Manual install test
在 Win/Mac/Linux 真机各跑一遍 installer, 验证:
- 首启 onboarding flow (`app/design/screen-onboarding.jsx`)
- Provider key 提示
- 第一节课生成 (goal-crystallize → lesson-generate → finish-ritual)
- 自动更新检查 (`update:check` IPC 不报错)

### C. Sweep-runner 修 (post-ship 也行)
4 个 LLM-bound smoke (`creation_system`/`full_chain`/`golden_path_e2e`/`route_goal`) 在 `npm run smoke:all` 并发跑时撞 LLM rate limit + 45s 超时. 选一:
- 简易: 编辑 `app/scripts/_dev_run_all_smokes.js`, 把这 4 个 smoke 的 `PER_TIMEOUT_MS` 提到 90_000
- 干净: 加 `RUN_SEQUENTIAL` 标记把这 4 个挪出并发池

---

## Ship 流程 (顺序执行)

```bash
# 1. 确认 working tree 干净
git status

# 2. tag rc.1 (release candidate, 先打个 rc 跑通 auto-update channel)
git tag v1.0.0-rc.1
git push --tags

# 3. CI 自动跑顺序: smoke.yml (smoke-gate) → build.yml (3-os 矩阵 dry build) → release.yml (signed publish, 如有 GH_TOKEN)
# 监 https://github.com/machinohataki-sys/hypha/actions

# 4. rc.1 在 3 台机器手动安装测试 (上面 §B)

# 5. 全绿 → 升正式版
git tag v1.0.0
git push --tags
# 同样 CI 矩阵跑. publish 后 auto-updater 把 rc.1 用户拉到 1.0.0.
```

回滚: 删 tag + GitHub UI 删 Release. 已下载的二进制无法强制撤回, 靠快 `v1.0.1` patch 修.

---

## 已 Ship (Code Layer, 不用动)

- 10 system 平均 ~84% (boot-10 audit, 见 `docs/V1_RELEASE_CHECKLIST.md` §1)
- 56 smoke / ~875+ assertion / 全过 standalone (`vault/.hypha/smoke-baseline.json`)
- Onboarding / vault safety / telemetry local-only / auto-updater (`app/lib/auto-updater.js` 386 LOC) / Pricing v3 / Cashflow Shield / Citation System / Evidence Ledger / Concept Ledger / Contamination Graph / T2_LOCAL 脚手架 / Boundary Guards
- CI: `.github/workflows/smoke.yml` + `build.yml` + `release.yml` 全 ready, secret 守护
- electron-builder 配置 (`package.json` §build) + macOS entitlements + 4 平台 icon (icns/ico/png/svg)
- 4 份用户文档: `README.md` + `docs/GETTING_STARTED.md` + `docs/PRIVACY.md` + `docs/ARCHITECTURE.md`

---

## 故意 Deferred (Post-v1.0)

按 user-value-per-week 排:

1. Sweep-runner 并发修 — 1-2 天, 消除 CI false-positive (上面 §C)
2. macOS icon.icns 真稿 + signing — 3-5 天 (设计师 + Apple Developer 账号)
3. Companion 本地 Gemma 3 4B 真集成 — v0.8, ~2 周 (Ollama T2_LOCAL, 脚手架已 ship)
4. BGE-M3 本地 embedding — v0.8+, 配 #3
5. Multi-device cloud sync — v1.5, ~4 周 (vault git/CRDT)
6. Stripe / WeChat Pay 真集成 — v1.5 (当前 rails 是 contract validate, 不是真支付)
7. Pack marketplace — v2.0+ (ed25519 author signing)
8. Mode Router triple-coupling (Exam ⇄ Growth ⇄ Hybrid) — v1.4
9. BYOK Western providers (OpenAI/Anthropic SDK 直连) — post-launch

---

## 已知坑

### A. smoke:all 4 个 FAIL 是假阳性
`creation_system` / `full_chain` / `golden_path_e2e` / `route_goal` 并发跑必 fail, standalone 跑必 pass. 已 verified 2026-05-20. 根因 = LLM 429 rate-limit collision + 45s 超时. **不阻塞 ship**, 但 CI cold runner 上可能看到同样的红. 修法见上面 §C.

### B. macOS Windows-first 退路
如果 Apple Developer cert 没拿到, 可以 ship Windows-first v1.0:
- 在 `package.json` `build.mac` 段加 `"target": []` 或注释整段
- `npm run build:win` 只产 .exe
- 后续 v1.1 补 macOS

### C. 不要做的事
- 不动 vault/ 任何文件 (用户数据)
- 不删 `release/build-hypha-learn-v0.4.3/` (历史 archive, 留对比)
- 不重写 anti-slop / persona-coherence 任何 spec 文件 (canonical 在桌面)
- 不绕 `vault/data/profile.json` 写 founder_purchased_at (v1.5 pricing 引擎要读)

---

## 验证 checklist (push tag 前最后一遍)

- [ ] `npm install` 干净, 无 ERR
- [ ] `package.json` version = `1.0.0`
- [ ] 4 个 LLM smoke standalone 都 PASS
- [ ] `git status` 干净 (除了 version bump)
- [ ] GitHub Secrets 至少有 `GH_TOKEN`
- [ ] CODEOWNERS owner 是真值 (不是 `@PLACEHOLDER_USERNAME`)
- [ ] `package.json` `build.publish[0]` owner/repo 是真值
- [ ] `build/icon.icns` 存在且 > 0 bytes (mac 需要; Windows-first 可跳)

全 [x] → 安全 tag.
