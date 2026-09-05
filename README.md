# DSH Memory

**Language / 语言**：[中文](#chinese-version) · [English](#english-version)

> **QQ 交流群**：倒霉蛋记忆中心交流群：1098935008

## Chinese Version

> 倒霉蛋 · 记忆中心 / Amnesia · Memory Center
> 让 AI Agent 拥有真正可持续成长的长期记忆。

**DSH Memory 不是**「简单聊天记录」「普通数据库」或「单纯向量搜索」——它是给 Agent 用的**结构化记忆引擎与知识演化系统**。记忆以你（以及未来的 Agent）都能读、能改、能审计的资产存在本地，而不是无法解释的黑盒。

```text
定位：Agent Memory Infrastructure · Structured Memory Engine · Knowledge Evolution System
```

| 身份 | 值 |
| --- | --- |
| 产品展示名 | Amnesia · Memory Center / 倒霉蛋 · 记忆中心 |
| 技术标识 | `dsh-memory`（npm 包名、Cordis 插件 id、HTTP 路由前缀 `/dsh-memory/*`） |
| 仓库位置 | `plugins/dsh-memory/` |
| 版本 | `0.1.0`（见 `package.json`） |

> 说明：**RAG-doc-fetcher 是历史 workspace / code name，不是最终产品品牌**。更早归档文档中出现的 `dsh-memory-personal` 是重命名前的旧技术标识，当前实现已统一为 `dsh-memory`。

## 目录

- [为什么需要 DSH Memory](#为什么需要-dsh-memory)
- [核心特性](#核心特性)
- [为什么选择 DSH Memory](#为什么选择-dsh-memory)
- [架构](#架构)
- [发布状态](#发布状态)
- [安装指南](#安装指南)
- [使用示例](#使用示例)
- [开发](#开发)
- [配置与注意事项](#配置与注意事项)

---

## 为什么需要 DSH Memory

### 没有长期记忆的 Agent

每一次对话都像第一次见面：

- 每次会话重新开始，跨会话上下文容易丢失；
- 用户偏好、项目决策、犯过的错无法积累为经验；
- Agent 无法从过去的学习中成长，同一个错误可能反复出现。

### 普通 RAG 的限制

RAG 解决的是「召回」，但它不解决「治理」：

- **只有召回，没有治理**——存进去的内容没有结构、没有归属、没有校验；
- **没有生命周期**——记忆不会过期、不会演化、不会被冲突检查；
- **无法人工编辑**——用户看不见 Agent 记住了什么，也无法修正；
- **无法恢复**——数据一旦写错没有版本、备份、回放；
- **无法学习错误**——反馈、失败、纠错都没有沉淀通道。

### DSH Memory 解决什么

| 能力 | 解决的问题 |
| --- | --- |
| **Structured Memory** | SQLite Source of Truth，schema 演进与审计，记忆不是黑盒 |
| **Retrieval Intelligence** | 查询理解 + 规划 + 关键词/向量混合 + 上下文分层，而非全文搜索 |
| **Experience Learning** | Experience 生命周期 + 反馈 + 冲突解决 + 错误智能，Agent 能从过去学习 |
| **Memory Governance** | 人工可编辑、可归档/恢复、可隔离/提升、全程审计 |
| **Reliability System** | 持久化事件队列 + Worker + 快照/备份/恢复 + 校验 |

一句话：DSH Memory 把「记忆」从**临时上下文**变成**可解释、可控制、可恢复、可演进、可治理的数据资产**。

---

## 核心特性

### 3.1 结构化记忆引擎

> Memory 不是黑盒数据。

- **SQLite Source of Truth**：本地单文件存储（默认 `<数据目录>/memory.db`），当前 schema v8；
- **Schema Migration**：单调版本号 + `schema_migrations` 记录，旧库同文件安全升级；
- **Version Control**：每次 create / update / archive / restore 都 `version + 1`；
- **Audit Log**：结构化写入与用户编辑均记录 before/after JSON，全程可审计；
- **Safe Migration / Legacy Takeover**：检测到旧插件同文件数据库时先备份（`<db>.pre-ts-r1.backup`）再迁移，报告显式输出，不静默替换。

### 3.2 人类可编辑的 Markdown 记忆

> Memory 是用户可以理解和管理的数据资产。

DB ↔ Markdown 双向同步（默认 `<数据目录>/memory/`，每条记忆一个 entry 文件）：

- **自动生成**：每条记忆渲染为带完整 frontmatter 的 Markdown，经 `memory_id` 回定位；
- **用户编辑保护**：直接编辑 `.md` 会被 parse → validate → 采纳回写，标记 `source=user-edited`；系统字段（id / version / 时间戳）不采纳用户修改；
- **Version tracking 与 Audit**：用户修改同样触发版本递增与审计；
- **watcher**：文件变更自动同步，杜绝手工与系统两边分叉。

### 3.3 智能检索系统

> 不是简单全文搜索。

R3 检索链路（只读，不产生记忆）：

```text
Query Understanding → Planner → FTS5 Keyword Retrieval → Context Assembly → Guard / Budget
```

- 低信息量/闲聊短路，查询语言/意图/范围规划；
- 词形归一 + 同义词/概念扩展，形成有序词项组；
- FTS5 词项分组检索 + metadata（project / scope / type）过滤；
- 结果按 profile / project / knowledge / constraints / experience 分层组装上下文；
- Guard 置信门槛与检索预算控制；检索不写库、不改记忆。

### 3.4 混合向量检索

R4 在 R3 之上追加向量路径：

```text
… Keyword ‖ Vector → Fusion → Reranker → Selector → …
```

- **sqlite-vec**：`vec0` KNN 索引，向量模型/维度变化自动整表重建并全量对账；
- **Embedding Provider 可插拔**：`hash`（本地确定性、零外部依赖）或 `http`（OpenAI 兼容 `/embeddings` 端点，缺端点即配置错误、fail loud）；
- **Fusion**：weighted 或 RRF（k=60），双侧候选合并并保留来源标记；
- **Reranking**：relevance / importance / confidence / recency / utility 多因子；
- 归档记忆不索引、不召回；`vector.enabled=false`（默认）时行为与 R3 完全一致。

### 3.5 经验学习

> Agent 可以从过去经验中学习。

R5 记忆治理域：

- **Experience Lifecycle**：candidate → investigating → solution-found → verified → validated，拒绝非法跳转；
- **Feedback**：confirm / deny / solved / not_helpful / obsolete 五类增量 + utility 学习（solved 单次推进 experience）；
- **Conflict Resolution**：同文/反义/共享词冲突检测 → review → supersede / merge / link / keep_separate，血缘自动记录；
- **Error Intelligence**：规则分类 + 四档分层建议与诊断顺序；
- **Quarantine**：低置信记忆自动隔离，可 promote / reject；隔离记忆默认不注入上下文。

### 3.6 可靠性基础设施

> 生产级可靠性。

R6 Durable 层（持久化队列而非内存态）：

- **Durable Event**：`events` 表持久化 + 幂等键，事务内入队；
- **Queue / Worker**：queued / processing / done / dead 状态机，租约认领、指数退避、dead 重放、`onUnhandled` 显式策略；
- **Replay**：`replay` 命令默认做 DB→Markdown 幂等重建，支持 dry-run 与自定义根目录；
- **Backup / Restore**：一致性快照与备份登记 + staged 校验恢复（默认输出 `restored-<id>.db`，支持 `--verify-only`）；
- **Validation**：`verify`（离线 SQLite 完整性/结构校验）与 `validate`（hygiene 扫描，过期记忆转 expired，可 dry-run）；
- 宿主接线：Worker、定时 consolidation、Continuous Validation、Memory Cache 随库启停；重启后残留 queued 事件自动恢复消费。

### 3.7 记忆中心 WebUI

R7 可操作面，纯静态单页六屏（`/dsh-memory/memory`）：

```text
library:    Overview / Memories / Experiences
review:     Conflicts / Quarantine
operations: System
```

- **Memory Management**：浏览/搜索/新建/编辑/归档/恢复，物理删除恒被禁（403）；
- **Review Center**：冲突评审（supersede / merge / discard）、隔离区评审（promote / reject）、经验推进（advance）；
- **Conflict Review**：近似重复进入 Conflicts、低置信进入 Quarantine，操作全部留审计；
- **Benchmark**：System 屏触发真实 Store 检索基准（keyword / latency / cache-hit / context / token-budget），种子数据单事务写入、结束回滚，零污染生产记忆。

---

## 为什么选择 DSH Memory

| 能力 | 普通聊天记录 | 普通 RAG | DSH Memory |
| --- | --- | --- | --- |
| 长期记忆 | 弱 | 中 | 强 |
| 知识治理 | 无 | 弱 | 强 |
| 人工编辑 | 无 | 弱 | 支持 |
| 经验学习 | 无 | 无 | 支持 |
| 生命周期管理 | 无 | 无 | 支持 |
| 恢复能力 | 弱 | 弱 | 支持 |

**DSH Memory 五大优势**

1. **可解释（Explainable）**——用户能打开 Markdown，知道 Agent 记住了什么；
2. **可控制（Controllable）**——用户可以修改记忆、纠正错误、屏蔽低置信内容；
3. **可恢复（Recoverable）**——Backup / Restore / Replay / Verify 全程可用；
4. **可演进（Evolving）**——记忆随经验持续积累、随反馈不断校准；
5. **可治理（Governable）**——冲突、反馈、隔离、生命周期都是一等公民。

---

## 架构

### 分层视图

```text
User / Agent
     │
     ▼
Ingest / Retrieval（CLI、HTTP API、Memory Center）
     │
     ▼
Structured Memory Store ── SQLite（schema v8 / migrations / audit）
     │
     ├──────────┬────────────┬────────────┬──────────────┐
     ▼          ▼            ▼            ▼              ▼
 Markdown    Retrieval   Vector        Governance    Reliability
 Projection   (R3)        (R4)          (R5)          (R6)
 DB ↔ MD      keyword +   sqlite-vec +  experience /   durable events /
 (R2)         context     provider +    feedback /     worker / cache /
              assembly    fusion +      conflict /     snapshot / backup /
                          rerank        quarantine /   restore / validate
                                        error-intel
     │
     ▼
Memory Center WebUI（R7，六屏）
```

### 设计原则

- **Plugin isolation**：以 Cordis 插件形态挂载，不侵入 DSH Core 的运行时文件；
- **Core zero intrusion**：宿主仅提供最小 Context 面（logger / 路由注册 / systemPrompt 席位 / 可选 web server），不依赖宿主内部实现；
- **Structured Source of Truth**：SQLite 是唯一事实源；Markdown、向量索引、缓存都是可重建的派生投影；
- **Explicit State Model**：temporal_state、experience_phase 等状态显式建模，遵循「不虚构状态」原则；
- **Safe Migration**：schema 单调演进，legacy 同文件升级前先备份，接管报告显式输出；
- **Retrieval is read-only**：检索永不写库、永不改变记忆。

---

## 发布状态

| 版本 | 能力 | 状态 |
| --- | --- | --- |
| R1 | Storage Foundation（SQLite Store + CLI + legacy takeover） | ✅ 2026-09-04 |
| R2 | Markdown Projection（DB↔MD 双向 + 编辑保护 + 归档/恢复） | ✅ 2026-09-04 |
| R3 | Retrieval Pipeline（FTS5 keyword + context assembly） | ✅ 2026-09-04 |
| R4 | Vector Search（sqlite-vec + hash/http provider + fusion + rerank） | ✅ 2026-09-04 |
| R5 | Memory Governance（experience / feedback / conflict / quarantine / error-intel） | ✅ 2026-09-04 |
| R6 | Reliability System（durable queue / worker / cache / backup / restore / validate） | ✅ 2026-09-05 |
| R7 | Memory Center（registry API + 六屏 WebUI + Review Center + Benchmark） | ✅ 2026-09-05 |
| R8 | Release Engineering（仓库整理 + Release Audit） | ✅ 2026-09-05 |

**状态表只反映已交付能力，不以路线图充当已实现功能。**

---

## 安装指南

以下步骤把 DSH Memory 从源码仓库装进一个可运行的 DSH 宿主。命令以当前实现为准（`package.json` 与 `lib/cli/index.js help` 一致）；路径示例基于本仓库的 `plugins/dsh-memory/`，若目录不同请按实际调整。

### 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | `>= 22.19`（建议 24.x） | `package.json` engines；ESM 包（`"type": "module"`） |
| npm | 随 Node 附带 | 用于安装插件的独立依赖 |
| DSH 宿主 | 一个可用的 dsh / Cordis 宿主 | 本仓库实际对接 `dsh web` profile（见下） |

SQLite 驱动说明（不必预装，安装时自动处理）：

- 主实现 `better-sqlite3`（devDependencies）在具备对应 ABI 预编译时使用；
- 不可用时运行期**显式降级**到 Node 内建 `node:sqlite`（Node 22 需 `--experimental-sqlite`，Node 24+ 免 flag），并在 `status`/`api/health` 中如实报告 driver，不静默替换；
- 默认 `auto`；可用环境变量 `DSH_MEMORY_SQLITE_DRIVER=better-sqlite3|node:sqlite|auto` 强制指定。

依赖事实（`package.json`）：运行依赖 `sqlite-vec ^0.1.9`；开发依赖 `typescript` / `vitest` / `tsx` / `@types/node` / `@types/better-sqlite3` / `better-sqlite3`。

### 2. 获取源码

```bash
git clone <repository>
cd plugins/dsh-memory
```

> 该插件是 DeepSeek Harness 仓库内的一个目录；本 README 以其当前仓库路径 `plugins/dsh-memory/` 为准。

### 3. 安装依赖

DSH Memory 使用**独立依赖环境**，依赖装进插件自己的 `node_modules/`，不会污染 DSH Core。

```bash
npm install
```

### 4. 构建插件

```bash
npm run build        # tsc -p tsconfig.json && tsc -p tsconfig.client.json
```

产物输出到 `lib/`（`lib/cordis/apply.js` 为插件主入口，`lib/cli/index.js` 为 CLI 入口，`lib/client.js` 为浏览器端入口）。

### 5. 安装到 DSH

DSH Memory 通过 **link 挂载 + profile patch** 分发（私有插件，不发布 npm registry）：

```bash
# 推荐：用 dsh 插件命令把插件 link 进目标 profile
dsh plugin --profile <profile> add link:/绝对路径/plugins/dsh-memory
```

等价的手工做法（机制相同，任何宿主都可用）：

1. 在 profile 的 `package.json` 中登记依赖与 bundle：
   ```json
   {
     "dependencies": {
       "dsh-memory": "link:/绝对路径/plugins/dsh-memory"
     },
     "dsh": { "bundles": ["dsh-memory"] }
   }
   ```
2. 把插件目录链接到 profile 的 `node_modules/dsh-memory`（junction / symlink 均可）。
3. 确保 node_modules 可解析 `sqlite-vec`（插件自带独立 `node_modules/`，已含运行依赖；无需把依赖装进宿主）。

插件包通过 `exports` 提供四个入口：`.`（Cordis apply）、`./client`（浏览器端面板）、`./cordis.patch.yml`（bundle patch）、`./package.json`。浏览器端组件注入 DeepSeek client runtime 与 locale，以 web 面板身份挂载。

**宿主配置**（在宿主 cordis.yml 的 `plugin.config` 下，所有键均可选）：

```yaml
# cordis.yml — 本插件的 plugin.config（示意）
plugin:
  config:
    enabled: true          # 总开关；false 时 apply() 直接返回，不打开存储
    announceToAgent: true  # 是否在 systemPrompt 席位发布插件引导段
    markdownEnabled: true  # Markdown Projection（DB↔MD 双向同步），缺省开启
    markdownDir: "data/memory"   # 缺省 <数据目录>/memory
    dataDir: "data"        # 数据目录；缺省 <插件根>/data（也受 DSH_MEMORY_DATA_DIR 影响）
    vector:                # R4 向量检索，缺省关闭
      enabled: false
      provider: hash       # hash（本地确定性）| http（OpenAI 兼容端点，需 baseUrl+model）
```

**启动 / 重启宿主**：重启你的 dsh 进程（本仓库的 web 宿主对应 `dsh-web-restart.ps1`），日志应无插件报错；启动后插件路由随宿主挂载在 `/dsh-memory/*`。

### 6. 初始化 Memory

首次运行（宿主启动或 CLI 打开库）时自动完成：**创建数据库 → 执行 schema migration → （检测到旧插件库时）备份并安全接管**。无需手工初始化。

如需要显式操作或排障：

```bash
node lib/cli/index.js init        # 初始化/迁移（必要时安全接管旧库）
node lib/cli/index.js migrate     # 显式执行并打印「旧库同文件升级」报告
node lib/cli/index.js status      # 查看存储状态、驱动、统计与 legacy 接管信息
```

CLI 全局参数：`--data-dir <dir>`（数据目录，默认 `DSH_MEMORY_DATA_DIR` 或 `<插件根>/data`）、`--db-file <name>`（默认 `memory.db`）。

### 7. 验证安装

```bash
# 本地 CLI 状态
node lib/cli/index.js status
```

输出示例（字段以实际环境为准）：

```text
store file : …/plugins/dsh-memory/data/memory.db
driver     : node:sqlite
  note     : node:sqlite (显式降级：better-sqlite3 不可用；Node 22 需 --experimental-sqlite，Node 24+ 免 flag)
schema v   : 8
memory rows: N（以实际数据为准）
legacy     : none
```

宿主 Web 路由验证（端口与宿主配置一致，本仓库示例 `3080`）：

```bash
curl http://127.0.0.1:3080/dsh-memory/api/health    # → {"ok":true, ...store 与 driver 信息}
curl http://127.0.0.1:3080/dsh-memory/api/config    # → driver / markdown / vector / worker 运行时视图
```

浏览器打开 `http://127.0.0.1:3080/dsh-memory/memory` 应看到 Memory Center（Overview / Memories / Experiences / Conflicts / Quarantine / System 六屏导航）。旧前缀 `/dsh-memory-personal/*` 已不再挂载（404）。

---

## 使用示例

命令以 CLI 为准。安装后可直接使用 bin `dsh-memory`；从源码目录运行等价于 `node lib/cli/index.js`（开发时也可 `npm run cli -- <command>`，经 tsx 跑 `src`）。写入结果可随时用 `search` / `status` 查证。

### 个人偏好

```bash
dsh-memory ingest --text "我偏好简洁直接的回复，避免不必要的客套话。"

dsh-memory search --query "用户对回复风格有什么偏好？"
```

偏好类内容经 ingest 管线（提取 → 重要度 → 去重幂等 → 入库）沉淀为 personal 记忆，之后同一 Agent 会话可稳定召回，而不是每轮重新问。

### 项目知识

```bash
dsh-memory ingest --project-id <projectId> --text \
  "本项目后端使用 DSH Memory 持久化跨会话记忆；前端为纯静态单页，无框架依赖。"

dsh-memory search --query "后端记忆方案是什么？" --project <projectId>
```

项目范围的内容按 `projects/<pid>/` 归组，检索用 `--project` 过滤，避免把 A 项目的知识带到 B 项目。

### 经验学习

```bash
dsh-memory experience create \
  --summary "better-sqlite3 在该 Node ABI 下无可用预编译" \
  --problem "require('better-sqlite3') 抛错导致应用无法启动" \
  --solution "配置 DSH_MEMORY_SQLITE_DRIVER=auto，让驱动层显式降级 node:sqlite" \
  --project-id <projectId> --scope project

dsh-memory experience list                      # 查看候选经验
dsh-memory experience advance <id> --phase verified   # 经验生命周期推进

dsh-memory feedback <memory-id> solved          # 反馈「已解决」→ 单次增量推进 experience
```

经验从 candidate 起步，按 investigating → solution-found → verified → validated 演进，非法跳转会被拒绝——Agent 不能自封“已验证”。

### 错误智能

```bash
dsh-memory error-intel --text "Error: EACCES: permission denied, open '/root/secret.key'"

# 或对已有日志文件诊断（写入诊断报告，不直接改写记忆）
dsh-memory error-intel --file /path/to/build.log --project-id <projectId>
```

error-intel 按规则把错误分类（network / shell / permission / memory / database 等），给出四档可用性分层与建议排查顺序，避免同类错误重复踩坑。

### 治理与维护（按需）

```bash
dsh-memory conflict detect <memory-id>          # 检测近似/反义冲突
dsh-memory conflict list --status open
dsh-memory conflict resolve <review-id> --resolution supersede --victim <id> --note "..."

dsh-memory quarantine auto                      # 低置信自动隔离
dsh-memory consolidate [--jaccard 0.8] [--deep] # 本地去重 / 深度合并

dsh-memory snapshot --note "每周快照"           # 一致性快照（登记入表）
dsh-memory backup --note "升级前备份"
dsh-memory replay --dry-run                     # 预览 DB→Markdown 重建计划
dsh-memory validate --dry-run                   # hygiene 扫描预览，不改写记忆
dsh-memory heal --requeue                       # dead 事件全部重新入队
```

完整命令清单以 `dsh-memory help` 为准；`benchmark` 命令会输出 JSON 报告并写入 `benchmark_runs`，不会污染生产记忆。

---

## 开发

### npm 脚本

| 命令 | 行为 |
| --- | --- |
| `npm run build` | `tsc -p tsconfig.json && tsc -p tsconfig.client.json`（产物进 `lib/`） |
| `npm run typecheck` | 三个 tsconfig（主 / tests / client）全量 `--noEmit` |
| `npm test` | `vitest run` |
| `npm run test:watch` | `vitest`（watch 模式） |
| `npm run cli -- <args>` | 源码直跑 CLI（tsx → `src/cli/index.ts`），免构建 |
| `npm run clean` | 删除 `lib/` |

测试基线：**13 个文件 / 133 用例全部通过**（R8 Release Gate 复跑记录，覆盖 store / legacy-takeover / projection / retrieval / r5 / r6 / r6-final / r7-http / r7-webui / r7-benchmark / r7-final 等）。测试使用插件自带 `node_modules/` 工具链运行。

只读取证工具（排障时使用，绝不修改源库）：

```bash
node --disable-warning=ExperimentalWarning \
  scripts/diagnose-store.mjs <memory.db> [--json <out.json>]
```

该脚本会把源库（连同 `-wal`/`-shm`/`-journal`）复制到临时目录后做完整性/结构/行数/与目标 DDL 的差异诊断，完成后删除副本。

### 目录结构

```text
plugins/dsh-memory/
├── src/
│   ├── store/          # SQLite 驱动适配层 + Store + migrations + legacy takeover
│   ├── ingest/         # 文本摄取管线（提取 → 评估 → 去重 → 落库）
│   ├── projection/     # DB↔Markdown：渲染 / 解析 / 采纳 / watcher
│   ├── retrieval/      # R3 关键词检索 + 查询理解 + 上下文组装 + 预算
│   ├── vector/         # sqlite-vec 存储 + 向量投影 + health 探测
│   ├── embedding/      # hash / http Embedding Provider
│   ├── rerank/         # 多因子重排
│   ├── memory/         # R5 治理域：experience / feedback / conflict /
│   │                   #   quarantine / error-intel / profile / consolidation
│   ├── reliability/    # R6：durable events / 队列状态机
│   ├── cache/          # 上下文感知检索缓存（水位失效）
│   ├── cost/           # 检索预算遥测
│   ├── worker/         # durable worker 与默认消费者
│   ├── api/            # Memory Center registry HTTP API（http.ts / context.ts）
│   ├── webui/          # Memory Center 静态单页（page.ts / app.js / models.ts）
│   ├── cli/            # 命令行入口与 R5/R6 子命令
│   ├── cordis/         # apply.ts —— 宿主接线入口（唯一被宿主加载的面）
│   ├── benchmark/      # R7 基准（seed + 回滚，零污染）
│   ├── schema/         # schema migrations 与枚举/类型
│   ├── util/           # 通用工具
│   ├── client.ts       # 浏览器端组件入口（设置分区）
│   └── paths.ts        # 数据路径解析与 DSH_MEMORY_* 环境变量
├── lib/                # 构建产物（勿手改）
├── tests/              # vitest 测试
├── scripts/            # 诊断/取证脚本
├── legacy-js/          # 历史 JS 实现归档（仅供对照/回滚，非当前架构）
├── cordis.patch.yml    # bundle patch（插入 profile dsh.bundles 的清单）
└── package.json
```

宿主只 import `cordis/apply.js` 这一个面；CLI、WebUI、store、worker 都是同一套 `lib/` 中的独立可组合模块（CLI 与宿主互不依赖，可在无 DSH 宿主环境下独立运行）。

---

## 配置与注意事项

### 数据目录与文件布局

```text
<数据目录>/                      # 默认 <插件根>/data
├── memory.db                  # SQLite Source of Truth（默认文件名 memory.db）
├── memory.db.pre-ts-r1.backup # legacy 接管前自动备份（仅在曾接管旧库时存在）
├── memory.db.vec              # sqlite-vec 向量索引（vector.enabled 时生成）
└── memory/                    # Markdown 投影根（默认 <数据目录>/memory）
    ├── profile/<id>.md        # personal 范围（偏好等）
    ├── constraints/<id>.md    # negative（约束/禁止项）
    ├── knowledge/<id>.md      # generalized 知识
    ├── projects/<pid>/<id>.md # project 范围
    ├── experiences/<id>.md    # experience
    └── archive/               # 归档区（archived 记忆文件迁移至此）
```

路径/环境变量与优先级：

| 变量 | 含义 |
| --- | --- |
| `DSH_MEMORY_DATA_DIR` | 数据目录兜底（当未显式配置 `dataDir` / `--data-dir` 时） |
| `DSH_MEMORY_SQLITE_DRIVER` | `auto`（默认）\| `better-sqlite3` \| `node:sqlite` |

优先级：显式配置（`dataDir` 配置项 / CLI `--data-dir`）> `DSH_MEMORY_DATA_DIR` > 默认 `<插件根>/data`。

### 如实说明的限制

- **SQLite 驱动**：主实现 `better-sqlite3` 需要与运行 Node ABI 匹配的预编译；不匹配时自动显式降级 `node:sqlite`（`Node 22` 需 `--experimental-sqlite`，`Node 24+` 免 flag 但仍打印 ExperimentalWarning，无害）。驱动选择可在 `status` / `api/health` / `api/config` 查看。具备 ABI 的环境应回归 better-sqlite3 主路径（当前 Windows 示例环境为降级态）。
- **sqlite-vec**：仅 `vector.enabled=true` 时加载扩展（`node:sqlite` 的 `loadExtension` 需要 `SQLITE_EXTENSION_DIR` 或绝对扩展路径）；环境不支持加载时 `health().available=false`，检索自动回退 R3，**不假装可用**；相关向量用例在无扩展环境自动跳过。
- **Embedding**：`hash` provider 是本地确定性的**非语义**向量（显式标注 `local-hash`，不冒充语义 embedding）；`http` provider 面向真实语义端点，需要可达的 OpenAI 兼容服务 + `baseUrl`/`model`，缺端点属配置错误、fail loud。生产级语义 embedding 接入属留后项。
- **宿主端到端**：Memory Center 页面在真实宿主上的六屏端到端交互验证登记为 R7-6 ⏳；本地 Release Gate（build / typecheck / vitest）与宿主管线 smoke 均已通过。
- **物理删除**：域层禁止物理删除记忆（一律 403 / CLI 拒绝），只能归档；WebUI 页面资源仅允许 GET。
- **维护命令边界**：`snapshot` / `backup` / `restore` / `replay` / `heal` / `consolidate` / `generalize` / `validate` 提供可用的基础语义；完整化的可靠性深化（如 generalized pattern 全自动发现、完整 proactive warning、cost/budget 自适应调参、独立 negative type 实证、跨域敏感过滤、统一置信校准引擎）属**留后项**，未按已实现功能宣传。
- **设计前提**：记忆是「上下文」而非「事实」；可解释、可编辑、可治理是一等特性。

---

## English Version

> Amnesia · Memory Center / 倒霉蛋 · 记忆中心
> Long-term memory for AI agents that genuinely keeps growing.

**DSH Memory is not** "simple chat logs," an "ordinary database," or "plain vector search" — it is a **structured memory engine and knowledge-evolution system** for agents. Memories live locally as assets you (and future agents) can read, edit, and audit, never as an unexplainable black box.

```text
Positioning: Agent Memory Infrastructure · Structured Memory Engine · Knowledge Evolution System
```

| Identity | Value |
| --- | --- |
| Display name | Amnesia · Memory Center / 倒霉蛋 · 记忆中心 |
| Technical id | `dsh-memory` (npm package, Cordis plugin id, HTTP route prefix `/dsh-memory/*`) |
| Repository path | `plugins/dsh-memory/` |
| Version | `0.1.0` (see `package.json`) |

> Note: **RAG-doc-fetcher is a historical workspace / code name, not the final product brand**. `dsh-memory-personal`, which appears in older archived documents, was the pre-rename technical id; the current implementation is uniformly `dsh-memory`.

## Table of Contents

- [Why DSH Memory](#why-dsh-memory)
- [Core Features](#core-features)
- [Why choose DSH Memory](#why-choose-dsh-memory)
- [Architecture](#architecture)
- [Release Status](#release-status)
- [Installation Guide](#installation-guide)
- [Usage Examples](#usage-examples)
- [Development](#development)
- [Configuration and Notes](#configuration-and-notes)

---

## Why DSH Memory

### The agent without long-term memory

Every conversation feels like a first meeting:

- Cross-session context is easily lost — each session restarts from scratch;
- User preferences, project decisions, and past mistakes never accumulate into experience;
- The agent cannot grow from past learning; the same error may repeat indefinitely.

### The limits of ordinary RAG

RAG solves "retrieval," not "governance":

- **Retrieval without governance** — stored content has no structure, ownership, or validation;
- **No lifecycle** — memories never expire, evolve, or get conflict-checked;
- **Not human-editable** — users cannot see what the agent remembers, nor correct it;
- **No recovery** — bad data has no versioning, backup, or replay;
- **No learning from mistakes** — feedback, failures, and corrections have no pipeline to settle into.

### What DSH Memory solves

| Capability | Problem it solves |
| --- | --- |
| **Structured Memory** | SQLite source of truth with schema evolution and audit; memory is not a black box |
| **Retrieval Intelligence** | Query understanding + planning + hybrid keyword/vector + layered context, not full-text search |
| **Experience Learning** | Experience lifecycle + feedback + conflict resolution + error intelligence; agents learn from the past |
| **Memory Governance** | Human-editable, archivable/restorable, quarantinable/promotable, fully audited |
| **Reliability System** | Durable event queue + worker + snapshot/backup/restore + validation |

In one sentence: DSH Memory turns memory from **transient context** into an **explainable, controllable, recoverable, evolving, governable data asset**.

---

## Core Features

### 3.1 Structured Memory Engine

> Memory is not black-box data.

- **SQLite source of truth**: a single local file (default `<data dir>/memory.db`), schema v8 today;
- **Schema migration**: monotonic version numbers + `schema_migrations` records; old databases upgrade safely in place;
- **Version control**: every create / update / archive / restore bumps `version + 1`;
- **Audit log**: structured writes and user edits both record before/after JSON — auditable end to end;
- **Safe migration / legacy takeover**: when an old plugin database is detected on the same file, it is backed up (`<db>.pre-ts-r1.backup`) before migration and the report is printed explicitly — never a silent replacement.

### 3.2 Human-Editable Markdown Memory

> Memory is a data asset users can understand and manage.

DB ↔ Markdown two-way sync (default `<data dir>/memory/`, one entry file per memory):

- **Auto-generated**: every memory renders to Markdown with full frontmatter and can be located back through `memory_id`;
- **User-edit protection**: editing a `.md` file directly runs parse → validate → adopt-and-write-back and is tagged `source=user-edited`; system fields (id / version / timestamps) never accept user changes;
- **Version tracking and audit**: user edits also bump the version and leave an audit trail;
- **Watcher**: file changes sync automatically, so the manual and system sides never fork.

### 3.3 Intelligent Retrieval System

> Not plain full-text search.

R3 retrieval pipeline (read-only; never creates memory):

```text
Query Understanding → Planner → FTS5 Keyword Retrieval → Context Assembly → Guard / Budget
```

- Low-information / chit-chat queries short-circuit; the planner decides query language, intent, and scope;
- Word-form normalization + synonym/concept expansion produce ordered term groups;
- FTS5 group-wise term retrieval + metadata (project / scope / type) filtering;
- Results are assembled into layered context by profile / project / knowledge / constraints / experience;
- Guard confidence threshold and retrieval budget; retrieval never writes to the store or mutates memory.

### 3.4 Hybrid Vector Search

R4 adds a vector path on top of R3:

```text
… Keyword ‖ Vector → Fusion → Reranker → Selector → …
```

- **sqlite-vec**: a `vec0` KNN index; when the embedding model or dimensionality changes, the whole table is rebuilt and fully reconciled;
- **Pluggable embedding provider**: `hash` (local, deterministic, zero external dependencies) or `http` (OpenAI-compatible `/embeddings` endpoint; a missing endpoint is a configuration error and fails loud);
- **Fusion**: weighted or RRF (k=60), merging both candidate sides while preserving source markers;
- **Reranking**: multi-factor over relevance / importance / confidence / recency / utility;
- Archived memories are neither indexed nor recalled; with `vector.enabled=false` (the default) behavior matches R3 exactly.

### 3.5 Experience Learning

> Agents can learn from past experience.

R5 is the memory-governance domain:

- **Experience lifecycle**: candidate → investigating → solution-found → verified → validated; illegal transitions are rejected;
- **Feedback**: five incremental kinds — confirm / deny / solved / not_helpful / obsolete — plus utility learning (a `solved` feedback advances an experience once);
- **Conflict resolution**: same-text / antonym / shared-term conflict detection → review → supersede / merge / link / keep_separate; lineage is recorded automatically;
- **Error intelligence**: rule-based classification with a four-tier advice ordering for diagnosis;
- **Quarantine**: low-confidence memories are isolated automatically and can be promoted or rejected; quarantined memories are not injected into context by default.

### 3.6 Reliability Infrastructure

> Production-grade reliability.

R6 is the durable layer (a persistent queue, not in-memory state):

- **Durable events**: the `events` table persists events with idempotency keys, enqueued inside transactions;
- **Queue / worker**: queued / processing / done / dead state machine with lease claims, exponential backoff, dead replay, and an explicit `onUnhandled` policy;
- **Replay**: `replay` re-derives DB→Markdown idempotently by default, with `--dry-run` and a custom root directory;
- **Backup / restore**: consistent snapshots and a backup registry, plus staged, validated restore (writes `restored-<id>.db` by default; supports `--verify-only`);
- **Validation**: `verify` (offline SQLite integrity/structure checks) and `validate` (hygiene scan that turns expired memories into `expired`; supports `--dry-run`);
- Host wiring: the worker, scheduled consolidation, continuous validation, and the memory cache start/stop with the store; leftover `queued` events resume consumption after a restart.

### 3.7 Memory Center WebUI

R7 is the operable surface — a pure static single page with six screens (`/dsh-memory/memory`):

```text
library:    Overview / Memories / Experiences
review:     Conflicts / Quarantine
operations: System
```

- **Memory management**: browse / search / create / edit / archive / restore; physical deletion is always blocked (403);
- **Review Center**: conflict review (supersede / merge / discard), quarantine review (promote / reject), and experience advancement (advance);
- **Conflict review**: near-duplicates land in Conflicts and low-confidence items in Quarantine; every operation stays audited;
- **Benchmark**: the System screen runs real store retrieval benchmarks (keyword / latency / cache-hit / context / token-budget); seed data is written in one transaction and rolled back when finished — zero pollution of production memory.

---

## Why choose DSH Memory

| Capability | Ordinary chat logs | Ordinary RAG | DSH Memory |
| --- | --- | --- | --- |
| Long-term memory | Weak | Moderate | Strong |
| Knowledge governance | None | Weak | Strong |
| Human editing | None | Weak | Supported |
| Experience learning | None | None | Supported |
| Lifecycle management | None | None | Supported |
| Recovery | Weak | Weak | Supported |

**DSH Memory's five strengths**

1. **Explainable** — open the Markdown files and know exactly what the agent remembers;
2. **Controllable** — edit memories, correct errors, and block low-confidence content;
3. **Recoverable** — Backup / Restore / Replay / Verify are all available;
4. **Evolving** — memory accumulates with experience and recalibrates with feedback;
5. **Governable** — conflicts, feedback, quarantine, and lifecycle are first-class citizens.

---

## Architecture

### Layered view

```text
User / Agent
     │
     ▼
Ingest / Retrieval (CLI, HTTP API, Memory Center)
     │
     ▼
Structured Memory Store ── SQLite (schema v8 / migrations / audit)
     │
     ├──────────┬────────────┬────────────┬──────────────┐
     ▼          ▼            ▼            ▼              ▼
 Markdown    Retrieval   Vector        Governance    Reliability
 Projection   (R3)        (R4)          (R5)          (R6)
 DB ↔ MD      keyword +   sqlite-vec +  experience /   durable events /
 (R2)         context     provider +    feedback /     worker / cache /
              assembly    fusion +      conflict /     snapshot / backup /
                          rerank        quarantine /   restore / validate
                                        error-intel
     │
     ▼
Memory Center WebUI (R7, six screens)
```

### Design principles

- **Plugin isolation**: mounts as a Cordis plugin and never touches DSH Core runtime files;
- **Core zero intrusion**: the host only exposes a minimal context surface (logger / route registration / systemPrompt slot / optional web server), never depending on host internals;
- **Structured source of truth**: SQLite is the only source of truth; Markdown, the vector index, and caches are all rebuildable derived projections;
- **Explicit state model**: states such as `temporal_state` and `experience_phase` are modeled explicitly, following the "no invented states" principle;
- **Safe migration**: schema evolves monotonically; legacy same-file upgrades back up first and print an explicit takeover report;
- **Retrieval is read-only**: retrieval never writes to the store and never mutates memory.

---

## Release Status

| Round | Capability | Status |
| --- | --- | --- |
| R1 | Storage Foundation (SQLite store + CLI + legacy takeover) | ✅ 2026-09-04 |
| R2 | Markdown Projection (DB↔MD two-way + edit protection + archive/restore) | ✅ 2026-09-04 |
| R3 | Retrieval Pipeline (FTS5 keyword + context assembly) | ✅ 2026-09-04 |
| R4 | Vector Search (sqlite-vec + hash/http providers + fusion + rerank) | ✅ 2026-09-04 |
| R5 | Memory Governance (experience / feedback / conflict / quarantine / error-intel) | ✅ 2026-09-04 |
| R6 | Reliability System (durable queue / worker / cache / backup / restore / validate) | ✅ 2026-09-05 |
| R7 | Memory Center (registry API + six-screen WebUI + Review Center + Benchmark) | ✅ 2026-09-05 |
| R8 | Release Engineering (repository tidy-up + Release Audit) | ✅ 2026-09-05 |

**The status table only reflects delivered capability; it never presents a roadmap as implemented functionality.**

---

## Installation Guide

These steps install DSH Memory from this source tree into a working DSH host. The commands reflect the current implementation (`package.json` and `lib/cli/index.js help`); paths assume this repository's `plugins/dsh-memory/` layout — adjust if your directory differs.

### 1. Requirements

| Item | Requirement | Notes |
| --- | --- | --- |
| Node.js | `>= 22.19` (24.x recommended) | `engines` in `package.json`; ESM package (`"type": "module"`) |
| npm | ships with Node | used to install the plugin's self-contained dependencies |
| DSH host | a working dsh / Cordis host | this repository targets the `dsh web` profile (see below) |

SQLite driver notes (nothing to preinstall — handled automatically):

- The primary implementation, `better-sqlite3` (devDependency), is used when a prebuilt binary matching the running Node ABI is available;
- Otherwise the runtime **explicitly falls back** to Node's built-in `node:sqlite` (needs `--experimental-sqlite` on Node 22; no flag on Node 24+) and honestly reports the driver in `status` / `api/health` — no silent substitution;
- Default is `auto`; force a choice with `DSH_MEMORY_SQLITE_DRIVER=better-sqlite3|node:sqlite|auto`.

Dependency facts (`package.json`): runtime dependency `sqlite-vec ^0.1.9`; devDependencies `typescript` / `vitest` / `tsx` / `@types/node` / `@types/better-sqlite3` / `better-sqlite3`.

### 2. Get the source

```bash
git clone <repository>
cd plugins/dsh-memory
```

> This plugin is a directory inside the DeepSeek Harness repository; this README follows its current repository path `plugins/dsh-memory/`.

### 3. Install dependencies

DSH Memory installs its own dependencies into the plugin's `node_modules/`; it never pollutes DSH Core.

```bash
npm install
```

### 4. Build the plugin

```bash
npm run build        # tsc -p tsconfig.json && tsc -p tsconfig.client.json
```

Artifacts go to `lib/` (`lib/cordis/apply.js` is the plugin entry, `lib/cli/index.js` the CLI entry, `lib/client.js` the browser-side entry).

### 5. Install into DSH

DSH Memory is distributed by **link mount + profile patch** (a private plugin; not published to an npm registry):

```bash
# Recommended: link the plugin into a target profile with the dsh plugin command
dsh plugin --profile <profile> add link:/absolute/path/plugins/dsh-memory
```

The equivalent manual procedure (the same mechanism, usable on any host):

1. Register the dependency and bundle in the profile's `package.json`:
   ```json
   {
     "dependencies": {
       "dsh-memory": "link:/absolute/path/plugins/dsh-memory"
     },
     "dsh": { "bundles": ["dsh-memory"] }
   }
   ```
2. Link the plugin directory into the profile's `node_modules/dsh-memory` (a junction or symlink both work).
3. Make sure `sqlite-vec` resolves from `node_modules` — the plugin ships its own `node_modules/` with the runtime dependency, so nothing needs to be installed into the host.

The package exposes four entries through `exports`: `.` (Cordis apply), `./client` (browser panel), `./cordis.patch.yml` (bundle patch), `./package.json`. The browser-side component injects the DeepSeek client runtime and locale, mounting as a web panel.

**Host configuration** (under `plugin.config` in the host's cordis.yml; every key is optional):

```yaml
# cordis.yml — this plugin's plugin.config (illustrative)
plugin:
  config:
    enabled: true          # master switch; when false, apply() returns without opening the store
    announceToAgent: true  # publish the plugin intro segment on the systemPrompt slot
    markdownEnabled: true  # Markdown Projection (DB↔MD two-way sync), on by default
    markdownDir: "data/memory"   # defaults to <data dir>/memory
    dataDir: "data"        # data dir; defaults to <plugin root>/data (DSH_MEMORY_DATA_DIR also applies)
    vector:                # R4 vector search, off by default
      enabled: false
      provider: hash       # hash (local deterministic) | http (OpenAI-compatible endpoint; needs baseUrl+model)
```

**Start / restart the host**: restart your dsh process (the web host in this repository maps to `dsh-web-restart.ps1`). The log should show no plugin errors, and the plugin routes mount under `/dsh-memory/*`.

### 6. Initialize Memory

The first run (host startup or any CLI open) automatically performs: **create database → run schema migrations → (when an old plugin database is detected) back up and take over safely**. No manual initialization is required.

For explicit operations or troubleshooting:

```bash
node lib/cli/index.js init        # initialize / migrate (safely take over an old database when needed)
node lib/cli/index.js migrate     # run migrations and print the same-file legacy upgrade report
node lib/cli/index.js status      # storage state, driver, counts, and legacy takeover info
```

CLI global flags: `--data-dir <dir>` (data dir; defaults to `DSH_MEMORY_DATA_DIR` or `<plugin root>/data`) and `--db-file <name>` (default `memory.db`).

### 7. Verify the installation

```bash
# Local CLI status
node lib/cli/index.js status
```

Example output (fields depend on your environment):

```text
store file : …/plugins/dsh-memory/data/memory.db
driver     : node:sqlite
  note     : node:sqlite (explicit fallback: better-sqlite3 unavailable; Node 22 needs --experimental-sqlite, Node 24+ needs no flag)
schema v   : 8
memory rows: N (as actually stored)
legacy     : none
```

Host web-route verification (port matches your host; `3080` in this repository):

```bash
curl http://127.0.0.1:3080/dsh-memory/api/health    # → {"ok":true, ...store and driver info}
curl http://127.0.0.1:3080/dsh-memory/api/config    # → runtime view of driver / markdown / vector / worker
```

Open `http://127.0.0.1:3080/dsh-memory/memory` in a browser: you should see Memory Center (Overview / Memories / Experiences / Conflicts / Quarantine / System navigation). The old `/dsh-memory-personal/*` prefix is no longer mounted (404).

---

## Usage Examples

Commands follow the CLI. After installation use the `dsh-memory` binary directly; from the source tree, `node lib/cli/index.js` is equivalent (during development `npm run cli -- <command>` runs `src` through tsx). Check the outcome any time with `search` / `status`.

### Personal Preference

```bash
dsh-memory ingest --text "I prefer concise, direct replies without unnecessary pleasantries."

dsh-memory search --query "What are the user's preferences on reply style?"
```

Preference content flows through the ingest pipeline (extract → evaluate importance → dedupe idempotently → store) and settles into personal memory. Later agent sessions recall it reliably instead of asking from scratch every time.

### Project Knowledge

```bash
dsh-memory ingest --project-id <projectId> --text \
  "This project persists cross-session memory with DSH Memory on the backend; the frontend is a framework-free static single page."

dsh-memory search --query "What is the backend memory solution?" --project <projectId>
```

Project-scoped content is grouped under `projects/<pid>/`; retrieval filters with `--project`, so knowledge from project A never leaks into project B.

### Experience Learning

```bash
dsh-memory experience create \
  --summary "better-sqlite3 has no usable prebuilt for this Node ABI" \
  --problem "require('better-sqlite3') throws and the application cannot start" \
  --solution "Set DSH_MEMORY_SQLITE_DRIVER=auto and let the driver layer explicitly fall back to node:sqlite" \
  --project-id <projectId> --scope project

dsh-memory experience list                      # list candidate experiences
dsh-memory experience advance <id> --phase verified   # advance the experience lifecycle

dsh-memory feedback <memory-id> solved          # mark "solved" → single incremental advance of an experience
```

Experiences start as `candidate` and evolve investigating → solution-found → verified → validated; illegal transitions are rejected — an agent cannot crown its own solution "verified".

### Error Intelligence

```bash
dsh-memory error-intel --text "Error: EACCES: permission denied, open '/root/secret.key'"

# or diagnose an existing log file (writes a diagnostic report; never rewrites memory directly)
dsh-memory error-intel --file /path/to/build.log --project-id <projectId>
```

`error-intel` classifies errors by rule (network / shell / permission / memory / database / …) and returns a four-tier usability recommendation with an ordered debugging plan, so the same class of error is not re-tripped blindly.

### Governance & Maintenance (as needed)

```bash
dsh-memory conflict detect <memory-id>          # detect near-duplicate / antonym conflicts
dsh-memory conflict list --status open
dsh-memory conflict resolve <review-id> --resolution supersede --victim <id> --note "..."

dsh-memory quarantine auto                      # auto-quarantine low-confidence memories
dsh-memory consolidate [--jaccard 0.8] [--deep] # local dedupe / deep merge

dsh-memory snapshot --note "weekly snapshot"    # consistent snapshot (registered in the table)
dsh-memory backup --note "pre-upgrade backup"
dsh-memory replay --dry-run                     # preview the DB→Markdown rebuild plan
dsh-memory validate --dry-run                   # hygiene-scan preview, no memory rewrites
dsh-memory heal --requeue                       # requeue every dead event
```

The full command list is authoritative in `dsh-memory help`; `benchmark` prints a JSON report and writes to `benchmark_runs`, never polluting production memory.

---

## Development

### npm scripts

| Command | What it does |
| --- | --- |
| `npm run build` | `tsc -p tsconfig.json && tsc -p tsconfig.client.json` (emits into `lib/`) |
| `npm run typecheck` | `--noEmit` across all three tsconfigs (main / tests / client) |
| `npm test` | `vitest run` |
| `npm run test:watch` | `vitest` (watch mode) |
| `npm run cli -- <args>` | run the CLI from source (tsx → `src/cli/index.ts`), no build required |
| `npm run clean` | delete `lib/` |

Test baseline: **13 files / 133 cases, all passing** (re-run record of the R8 Release Gate; covering store / legacy-takeover / projection / retrieval / r5 / r6 / r6-final / r7-http / r7-webui / r7-benchmark / r7-final and more). Tests run on the plugin's own `node_modules/` toolchain.

Read-only forensics (for troubleshooting; never modifies the source database):

```bash
node --disable-warning=ExperimentalWarning \
  scripts/diagnose-store.mjs <memory.db> [--json <out.json>]
```

The script copies the source database (with `-wal` / `-shm` / `-journal`) into a temp directory, runs integrity / structure / row-count / DDL-diff diagnostics against the target schema, and deletes the copy afterwards.

### Directory layout

```text
plugins/dsh-memory/
├── src/
│   ├── store/          # SQLite driver adapter + Store + migrations + legacy takeover
│   ├── ingest/         # text ingestion pipeline (extract → evaluate → dedupe → store)
│   ├── projection/     # DB↔Markdown: render / parse / adopt / watcher
│   ├── retrieval/      # R3 keyword retrieval + query understanding + context assembly + budget
│   ├── vector/         # sqlite-vec storage + vector projection + health probing
│   ├── embedding/      # hash / http Embedding Providers
│   ├── rerank/         # multi-factor reranking
│   ├── memory/         # R5 governance domain: experience / feedback / conflict /
│   │                   #   quarantine / error-intel / profile / consolidation
│   ├── reliability/    # R6: durable events / queue state machine
│   ├── cache/          # context-aware retrieval cache (watermark invalidation)
│   ├── cost/           # retrieval budget telemetry
│   ├── worker/         # durable workers and default consumers
│   ├── api/            # Memory Center registry HTTP API (http.ts / context.ts)
│   ├── webui/          # Memory Center static single page (page.ts / app.js / models.ts)
│   ├── cli/            # CLI entry and R5/R6 subcommands
│   ├── cordis/         # apply.ts — host wiring entry (the only face the host loads)
│   ├── benchmark/      # R7 benchmarks (seed + rollback; zero pollution)
│   ├── schema/         # schema migrations and enum/type definitions
│   ├── util/           # shared utilities
│   ├── client.ts       # browser-side component entry (settings pane)
│   └── paths.ts        # data-path resolution and DSH_MEMORY_* environment variables
├── lib/                # build output (do not edit by hand)
├── tests/              # vitest tests
├── scripts/            # diagnostic / forensic scripts
├── legacy-js/          # archived historical JS implementation (reference/rollback only)
├── cordis.patch.yml    # bundle patch (the entry listed in a profile's dsh.bundles)
└── package.json
```

The host imports only the `cordis/apply.js` face; the CLI, WebUI, store, and worker are independently composable modules of the same `lib/` (the CLI carries no DSH-host dependency and runs standalone).

---

## Configuration and Notes

### Data directory and file layout

```text
<data dir>/                        # defaults to <plugin root>/data
├── memory.db                  # SQLite source of truth (default file name memory.db)
├── memory.db.pre-ts-r1.backup # automatic pre-takeover backup (only after taking over a legacy DB)
├── memory.db.vec              # sqlite-vec vector index (created when vector.enabled)
└── memory/                    # Markdown projection root (default <data dir>/memory)
    ├── profile/<id>.md        # personal scope (preferences and the like)
    ├── constraints/<id>.md    # negative (constraints / prohibitions)
    ├── knowledge/<id>.md      # generalized knowledge
    ├── projects/<pid>/<id>.md # project scope
    ├── experiences/<id>.md    # experiences
    └── archive/               # archive area (archived memory entry files move here)
```

Paths, environment variables, and precedence:

| Variable | Meaning |
| --- | --- |
| `DSH_MEMORY_DATA_DIR` | fallback data dir (when no explicit `dataDir` config / `--data-dir`) |
| `DSH_MEMORY_SQLITE_DRIVER` | `auto` (default) \| `better-sqlite3` \| `node:sqlite` |

Precedence: explicit config (`dataDir` option / CLI `--data-dir`) > `DSH_MEMORY_DATA_DIR` > default `<plugin root>/data`.

### Honest limitations

- **SQLite driver**: the primary `better-sqlite3` needs a prebuilt binary matching the running Node ABI; when mismatched, the runtime explicitly falls back to `node:sqlite` (Node 22 requires `--experimental-sqlite`; Node 24+ needs no flag but still prints a harmless ExperimentalWarning). The active driver is visible in `status` / `api/health` / `api/config`. Environments with a matching ABI should return to the better-sqlite3 main path (the current Windows sample environment runs the fallback).
- **sqlite-vec**: the extension loads only when `vector.enabled=true` (`node:sqlite`'s `loadExtension` needs `SQLITE_EXTENSION_DIR` or an absolute extension path); when loading is unsupported, `health().available=false`, retrieval degrades back to R3, and nothing pretends otherwise. Vector test cases auto-skip where the extension cannot load.
- **Embedding**: the `hash` provider produces local, deterministic, explicitly **non-semantic** vectors (tagged `local-hash`; it never masquerades as semantic embeddings); the `http` provider targets real semantic endpoints and needs a reachable OpenAI-compatible service plus `baseUrl` / `model` — a missing endpoint is a configuration error and fails loud. Production-grade semantic embedding integration is a follow-up item.
- **Host end-to-end**: end-to-end interaction across all six Memory Center screens on a real host is registered as R7-6 ⏳; the local Release Gate (build / typecheck / vitest) and the host pipeline smoke both pass.
- **Physical deletion**: the domain layer forbids physically deleting memories (403 / the CLI refuses); memories can only be archived, and WebUI page assets are GET-only.
- **Maintenance-command scope**: `snapshot` / `backup` / `restore` / `replay` / `heal` / `consolidate` / `generalize` / `validate` provide usable baseline semantics. The deeper reliability work — fully automatic generalized-pattern discovery, complete proactive warnings, adaptive cost/budget tuning, empirical separate negative types, cross-domain sensitive filtering, and a unified confidence-calibration engine — are **follow-up items**, not marketed as implemented.
- **Design premise**: memory is "context," not "fact"; explainability, editability, and governance are first-class properties.
