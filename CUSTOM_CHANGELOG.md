# 🛠️ Microsoft Rewards 定制版本与变更历史 (Custom Patch Changelog)

## 2026-10-08 — [v0.1.1] 跨天状态隔离重置、Daily Set计分修正与关于面板

- REQ-VERSION-ABOUT-AND-DAY-ISOLATION-20261008：
  - 跨天缓存重置与日历隔离：修复跨天换天时移动端缓存状态未自动归零（残留前一日 260/380 分）的问题，`/api/unified/state` 严格限制今日积分仅统计当前日历日；
  - Daily Set 独立计分修正：修复统一状态接口中 Daily Set 任务卡片进度被全日总分污染的问题，严格统计 Daily Set 自身卡片分值（30/30）；
  - 控制台“关于项目 (About)”面板：新增 Fluent 风格关于页面，展示当前版本号（v0.1.1）、开源协议、上游致谢与当前版本核心 Changelog；
  - 历史更新日志直达：历史全量版本更新日志一键直达 GitHub Releases 与 CUSTOM_CHANGELOG.md，保持控制台界面轻量清爽。

## 2026-10-03 — 人机协同半自动风控质询响应、避险通知与高危任务熔断机制 (HITL)

- REQ-HITL-BOT-CHALLENGE-POLICY-20261003：
  - 核心设计：针对微软官方 `Fraud_UserWarning_BotScore_UX` 账号级风控质询，摒弃粗暴的“退出跳过”与“盲目硬跑”，落地方案一（HITL 人机协同避险）：
    1. 自动挂起 PC 桌面搜索、移动端搜索与 Bonus 搜索，杜绝批量高危搜索导致封号；
    2. 允许并继续执行日常打卡（Daily Check-in）、资讯阅读（Read to Earn）、每日集卡（Daily Set）、推广卡片（More Promotions）及打卡集点（Punch Cards）；
    3. 生成 B/S 界面顶部人机质询横幅与一键破冰官方直达链接（`https://rewards.bing.com`，经 `sanitizeUrl` 防 XSS 处理）；
    4. 支持向 Discord / Telegram / Server酱 / PushPlus 等 Webhook 渠道异步推送质询告警，提醒用户在手机 Bing App 或电脑 Edge 进行 1~2 次日常搜索或人机拼图破冰；
    5. 微软接口风控标记解除后，程序在下一次运行时自适应恢复全量搜索。
  - 变更文件：
    - 新增：[`src/util/HitlBotChallenge.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/util/HitlBotChallenge.ts)、[`scripts/api/hitlBotChallenge.mjs`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/hitlBotChallenge.mjs)、[`scripts/api/hitlBotChallenge.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/hitlBotChallenge.test.js)；
    - 修改：[`src/index.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/index.ts)（任务挂起与多账号 workers 还原）、[`web.mjs`](file:///Users/junzhuang/Antigravity/ms_rewards/web.mjs)（日志检测、SSE 广播与 Webhook 派发）、[`public/index.html`](file:///Users/junzhuang/Antigravity/ms_rewards/public/index.html)（顶部质询横幅与 SSE 响应）。
  - 验证：TypeScript 编译成功构建输出至 `dist/`；专属单元测试 11 项全过；全量 278 项自动化回归测试 100% 通过（0 fail）；外部目录与 sessions 保持零写入零污染；后台常驻 PID 239 服务未受干扰。

## 2026-09-30 — 源码直接运行架构确立、Docker 依赖完整打包与镜像构建约束


- REQ-DEPLOY-SOURCE-MODE-AND-DOCKER-RUNTIME-SPEC-20260930：
  - 架构确立：明确当前生产运行形态为宿主机源码直接运行（macOS/Linux/Windows, `node web.mjs` / `./web.sh`），Docker 为未来 GitHub Actions 构建发布至 Docker Hub 的交付目标；
  - 依赖完整打包：在 `Dockerfile` 运行阶段补全 `web.mjs` 静态引用的 `promotion-classification.mjs`、`promotion-classification.cjs` 以及动态调用的 `doctor.mjs`、`mobile-doctor.mjs`、`scripts/main/` 目录；
  - 镜像与构建解耦：文档与 `compose.yaml` 消除误用上游 GHCR 未修复镜像的歧义，明确本地构建必须同时设置 `build:` 上下文与独立本地标签（`image: microsoft-rewards-script:local` 或 `microsoft-rewards-web:local`），并执行 `docker compose up -d --build`；
  - 验证与限制声明：Windows 跨平台适配（移除 NODE_PATH 虚假 fallback，采用 junction/symlink 失败时显式 `t.skip` 动态仿真，并独立保留全部静态语法与打包规则校验），本地运行时文件布局仿真测试加载全绿，.dockerignore 敏感文件过滤与依赖保留确定性校验通过，全量 265 项测试 100% 通过；测试套件彻底完成前置环境变量隔离治理（坦诚说明修复前全量测试存在读取宿主机已有 .device_key 的暴露面，mtime 未变仅证明无写操作，修复后经源码审查结合外部哨兵目录零文件生成证明未来测试 100% 隔离）；宿主机 Docker 守护进程未启动，镜像运行时处于未测试状态，宿主机运行中服务 PID 6912 保持零重启。

## 2026-09-30 — Web 控制台首次配对易用性、Docker 局域网访问适配与安全收尾

- REQ-AUTH-PAIRING-USABILITY-AND-DOCKER-20260930：
  - 核心功能：实现单机 Docker 架构下 Web 控制台首次配对后长期免密。自动生成高熵配对码落盘至宿主机持久化目录（`compose.yaml 所在目录/sessions/.web_pairing_secret`，宿主机隐藏文件，免 `docker exec`），配对成功后浏览器持有独立长期高熵 Cookie 无感访问；
  - 关键安全整改：
    1. 配对码持久化 fail closed 治理与异常文件完整性保留（空/损坏文件降级 500 锁屏，严禁生成新码覆盖原文件）；
    2. 手工配置配对密码至少 15 字符与弱密码拦截；
    3. `TRUSTED_PROXIES` 可信代理白名单：仅在连接来自白名单代理时解析 `X-Forwarded-For` 与 `X-Forwarded-Proto`，默认防御客户端头伪造并启用 5 次失败锁定 60 秒防爆破；
    4. 严格 Host 端口校验、协议一致性匹配与 Docker 宿主机映射端口 Origin 同源放行；
    5. CSRF 令牌彻底解耦配对密码，改由设备私钥与服务端 `authEpoch` HMAC 派生，管理员更换配对密码后旧浏览器读写畅通无感，执行“撤销所有设备授权”瞬时全部失效；
    6. 前端文案与安装文档统一（`INSTALL.md`、`README.md`、`compose.yaml`）。
  - 验证：9 项专属安全测试、15 项安全审计测试及全量 261 项测试全部通过（100% pass）；外部哨兵目录零写入验证通过；TypeScript 构建成功。未在生产 Docker / 外部公网验证。

## 2026-09-30 — 卡片全态分类、跳过策略与官方契约对齐

- REQ-CARD-TAXONOMY-AND-SKIP-POLICY-20260930：
  - 前端视觉：Daily Set 丰富化识别为即时浏览/问答Quiz/投票Poll/需交互/待核实；Explore on Bing 细分为金融/数码/出行/票务等8大主题与四态流转（待激活/进行中/明日激活/已完成）；
  - 执行跳过：全面实现 6 大安全跳过策略（`skip_tomorrow_locked` 次日锁定、`skip_complete` 已满分、`skip_cooldown_reached` 冷却熔断、`skip_manual_required` 人工交互、`skip_non_point_tasks` 0分纯广告、`skip_safety_guard` 风控熔断），覆盖 PC MorePromotions、DailySet、移动 MobileDailySet 及 AppPromotions。
  - 验证：TypeScript 构建成功，全套 198 项自动化回归测试通过，离线模拟与页面静态检查通过。

## 2026-09-12 — 轻量规则入口与按层交付

- REQ-DOC-LIGHT-20260912：新增短 AGENTS.md，定向读取规则；注册表文首修正并入对应条目，验收流水留在需求文档；明确代码、页面、协议交付层级。
- 静态链接、契约迁移、历史需求正文及业务文件哈希检查通过。未改业务、运行服务或积分任务，未调整全局 skills。

## 2026-09-07 — 项目规则去重与历史归档

- REQ-DOC-CONTEXT-CLEANUP-001：需求入口保留当前约束与编号索引，原 2054 行正文完整迁至 [历史归档](docs/archive/REQUIREMENTS_2026-09-06.md)；字段契约统一到接口注册表，UI 权限统一到 UI 规范，安卓诊断步骤留在专册。
- 项目专用 workflow skill 从 91 行缩至 24 行，按任务路由；取消全任务 CodeGraph、固定中间状态落盘和无条件真实账号跑测。保留最小修改、隐私、终端隔离及真实验收边界，明确被替代的同步频率、跨端复用和 Daily Set 旧规则。
- 验证：归档正文完整性、49 个 REQ 链接、本地链接与锚点、skill 元数据和 diff 检查通过；461 个业务/配置/构建文件哈希未变。仅文档与 skill 验收，不宣称任何积分功能新通过验证，未执行真实任务。


## 2026-09-05 — 移动交互任务逐卡跳过

- REQ-MOBILE-INTERACTIVE-SKIP-001：Daily Set 复用同步分类器，执行前重读状态；已完成优先跳过，交互卡零提交/导航，其余卡继续。More 原有跳过逻辑、PC、积分与完成口径不变。
- 验证：TypeScript 编译成功，API 回归 84/84 通过，CodeGraph 最新；未运行真实积分业务。

> **版本命名规范 (Versioning Convention)**:  
> **`v<上游版本>-patch<定制版本>`**（例如：**`v4.3.1-patch1.6.0`**）  
> - **前半部分 (`v4.3.1`)**：严格跟随官方原作者仓库 (`TheNetsky/Microsoft-Rewards-Script`) 的发布版本。当原作者发布 `v4.3.2` 时，前缀自动递增为 `v4.3.2`。  
> - **后半部分 (`patch1.6.0`)**：记录我们所有专属定制功能、UI 看板、底层修复与策略优化的迭代版本。

---

## 📌 版本演进与变更历史 (Changelog)

### 📱 [移动端 Daily Set 交互状态机、落地页动作与投票容错] - 2026-09-05

#### REQ-MOBILE-DAILY-SET-DEDICATED-HANDLER-001 (移动端 Daily Set 完整交互优化)

- 修复 `options=612` 缺少 `profile.ruid` 导致移动任务上报 `app_activity_context_incomplete`：在 `src/constants/urls.ts` 将 `URLs.platform.me` 查询参数升级为 `options=613`（`612 | 1` 一次性获取任务和 profile），并在 `src/functions/activities/app/AppActivity.ts` 的 `submitAppActivity` 中增加缺失 `ruid` 时的 `options=1` 动态回退机制；
- 修复移动 Daily Set 落地页误判：放宽 `src/functions/activities/app/MobileDailySet.ts` 对非 `/search` 官方目标链接（如 `rewards.bing.com/refer`）的校验限制，将合法的非搜索官方直链作为 `kind: 'url'` 任务执行，解决 `missing_or_untrusted_destination` 误跳过问题；
- 新增 URL 类任务客户端动作触发：针对 `rewards.bing.com/refer` 等推荐/分享任务，自动识别并点击“Copy link” / “Share”按钮，触发客户端事件使得 SAAndroid 状态顺利入账；
- 优化 Quiz 题库状态机与结果提交：识别最后一题提交为 `<a class="acf-button-standard__link" title="View result">` 链接，通过 `isResult` 判定及时点击并跳转结果页退出循环；选项过滤排除 `'next'`、`'result'` 和轮播 `'event'`，彻底根除死循环与误点问题；
- 完善 Poll 投票选择器隔离与已关闭检测：将投票选择器严格限定在 `#b_pole` 与 `.btOption` 内部，避免误点 Bing 底部的词典链接；新增 `isPollClosed()` 检测，对跨时区尚未开放的投票（"The poll is closed"）输出日志并优雅跳过，不再抛错；
- 自动化回归验证：新增 4 项单元测试，全套 81 项回归测试全部通过，`src/` 目录 ESLint 0 错误 0 警告。

### 📐 [Gemini UI 交接与权限边界] - 2026-09-04

#### REQ-GEMINI-UI-HANDOFF-001

- 登记当前未完成工作的优先级、验收动作和完成条件，避免交接后重复排查或提前宣称完成；
- 明确 Gemini、OpenDesign 及其他 UI/UX 工具只负责局部展示层设计，不得修改接口语义、积分口径、任务归属、完成判定、执行器或 Session；
- UI 采用“方案先确认、再做最小补丁”的两阶段流程，并要求修改前后业务快照一致、通过响应式/主题/无障碍及相关回归；
- 项目开发流程 Skill 已同步并通过结构校验，本次未修改任何运行代码。

### ⏭️ [PC 已完成 Edge 跳过与子卡状态隔离] - 2026-09-03

#### REQ-PC-EDGE-PREFLIGHT-AND-CARD-STATUS-001

- Edge Browsing 在任何 App profile、激活或上报前先复核 Rewards Web 当前 streak；当天已经 `30/30` 时立即 `skip_complete`，不再启动 6 次上报或等待约 31 分钟；
- Keep earning/More activities 运行期间，0 分信息/导航卡不再显示“执行中”，未完成人工卡保持“人工任务”，只有可自动执行的正分待完成卡继承组级运行状态；
- 真实卡住日志已完成根因定位并停止旧运行；刷新 3888 页面可视验证状态恢复正确；
- 测试先行失败证据有效；构建、70 项回归、页面/Web 语法、定向 lint、diff 与 CodeGraph 全部通过。

### ✅ [Keep earning 人工任务二态展示] - 2026-09-03

#### REQ-KEEP-EARNING-MANUAL-TWO-STATE-001

- PC Keep earning 与移动 More activities 的人工类卡现在只有互斥的两种展示：官方未完成时显示“人工任务”，官方确认完成后只显示“已完成”；
- 人工二态作用域在页面硬限制为 `promotions/appPromotions`，不会扩散到 Daily Set、Search、Read 或签到；
- 完成状态与积分到账分开处理，栏目小计、今日积分和公共余额继续只消费官方同步值，本次未修改任何积分计算或接口；
- 测试先行失败证据有效；构建、68 项回归、页面/Web 语法、定向 lint、diff 与 CodeGraph 全部通过。

### 👤 [Keep earning 人工任务标记与门控] - 2026-09-02

#### REQ-KEEP-EARNING-MANUAL-TASK-001

- PC Keep earning 和移动 More activities 中需用户操作的卡统一返回 `requiresManualInteraction` 并显示“人工任务”；
- `Set a goal` 现按 Rewards `/goal` 官方 destination 识别，PC 执行时直接 `skip_manual_required`，不再重试 UrlReward；移动 App 交互卡保留已验证的零通用 POST 行为；
- 人工分类严格限定在 Keep earning/More，两端 Daily Set 不生成标记、不调用该门控，原有 URL/Quiz/Poll 专用执行保持不变；
- 构建、68 项回归、定向 lint/语法/diff 和 CodeGraph 通过；实时两端同步与 PC 实际执行验收通过。

### 🧭 [两端全流程终端与状态一致性] - 2026-09-02

#### REQ-FULL-RUN-TERMINAL-CONSISTENCY-001

- PC Daily Set、Keep earning、Punch Cards、Search 等实际 worker 统一在 desktop context/会话执行，删除 Punch Cards 重复路径，PC 不再执行 Rewards App 专属投放；
- 0 分官方信息卡保留展示但不执行；worker `POINTS-BREAKDOWN/TASK-DISCOVERY` 改为纯诊断日志，不再覆盖 preflight/postflight 权威状态；
- 任务异常只归属给能明确推断的 taskId，quota 每次从同一规范化卡片快照派生，移动流程不输出 PC 诊断口径；
- 建立可复用排障手册并将“先查已验证方法、成功后沉淀、命中止损条件就停止重试”写入项目 skill；
- 构建、67 项回归、定向 lint/语法/diff 与 CodeGraph 全部通过；真实 PC 和移动各跑一次均退出 0，最终官方值稳定，手动交互任务正确保持待完成。

### 📱 [移动 Daily Set 原生交互恢复] - 2026-09-02

#### REQ-MOBILE-DAILY-SET-DEDICATED-HANDLER-001

- 移动 Daily Set 现在从 SAAndroid 当前卡片动态读取并验证 Bing destination，按 URL offer、Quiz、Poll 三种真实页面交互执行；继续禁用已证实无效的裸 `AppReward type=101`；
- 每张卡执行前后均按移动账号日期和精确 offer ID 重读 `options=612`，只有官方完成字段或进度达上限才算成功；不影响 More activities APP任务过滤、PC Daily Set 或两端积分口径；
- 新增非 Root 安卓 Bing Rewards 诊断文档，固定采用 WebView DevTools，明确 PCAPdroid MITM 证书不受信任时停止解密尝试，并规定隐私清理；
- 真机三张当日卡全部由 `0/10` 变为 `10/10`、Daily Set 达到 `30/30`；构建、59/59 回归、定向 ESLint、Web 语法、diff 与 CodeGraph 检查通过。

### 🟡 [手动任务待完成状态纠正] - 2026-09-02

#### REQ-TASK-STATUS-MANUAL-PENDING-001

- 正常运行结束且官方仍返回待完成时，PC/移动任务状态保持“⏳ 待完成”；`skip_manual_required` 与 `skip_manual_app_interaction` 不再被收尾逻辑误报为“❌ 异常”；
- 明确错误、非零退出仍显示异常，官方完成、状态不可用及用户主动停止的既有语义保持不变；
- 删除运行日志中的 `allTasksDone=true` 硬编码，全部完成仅由同次规范化官方快照汇总；未改动任何微软接口或积分口径；
- 验证：测试先行失败 1 项后修复，构建、57/57 回归、Web/页面语法、diff 与 CodeGraph 检查通过。

### 🕛 [下一次任务刷新时间纠正] - 2026-09-02

#### REQ-TASK-REFRESH-FUTURE-001

- PC/移动“下一次刷新”统一改为浏览器/OS 系统时间之后的下一个本地零点，不再因某一终端官方周期滞后而显示已经过去的时间；
- 本次仅修正界面时间估算，PC Rewards Web 与移动 SAAndroid 的官方日期、任务状态和执行门控保持隔离且未改动；
- 验证：测试先行失败 1 项后修复，构建、56/56 回归、页面语法、两端真实渲染、diff 与 CodeGraph 检查通过。

### 🧹 [两端任务更新时间简化] - 2026-09-02

#### REQ-TASK-REFRESH-SIMPLIFY-001

- PC/移动 Hero 卡的刷新信息精简为“任务更新时间（系统获取）”和一行“下一次刷新”，不再向普通用户展示官方周期、最近同步或 IANA 时区；
- 删除设置页的手动时区选择与相关前端代码，页面始终使用浏览器/OS 系统时区；PC 和移动仍各自使用官方 `dailySetDate`，不改执行或积分口径；
- 验证：测试先行失败 1 项后修复，构建、56/56 回归、页面语法、真实两端/设置页渲染、diff 和 CodeGraph 检查通过。

### 🛡️ [移动执行终端隔离与 Daily Set 安全止损] - 2026-09-02

#### REQ-MOBILE-EXECUTION-ISOLATION-001

- `REWARDS_MODE=desktop/mobile` 现在是执行副作用的硬边界：移动运行不再启动 Edge/PC 任务，PC 运行也不会触发移动 Search、Read、Check-in、App Promotions 或 Mobile Daily Set；
- 实测已证明无效的 Mobile Daily Set 通用 `AppReward type=101` 路径已停用；程序仍重读 SAAndroid 当天卡片，未完成时明确 `skip_manual_required` 并零 POST；
- 采用测试先行：旧实现先稳定失败 2 项，补丁后构建、56/56 相关回归、定向 lint、diff 和 CodeGraph 检查通过；未调用任何微软写入接口。

### 🕒 [两端任务刷新信息与显示时区] - 2026-09-02

#### REQ-TASK-REFRESH-TIMEZONE-001

- PC/移动 Hero 账户区分别显示各自的官方任务周期、带“估算”标记的下一周期零点和最近同步时间，不改变任务判断或执行；
- 管理与配置新增“跟随系统”与手动 IANA 时区选择，保存到 `display.timeZone`，后端拒绝无效时区；
- 实测 PC `09/01/2026` 与移动 `09/02/2026` 周期同时正确显示；构建、55/55 回归、三页真实渲染、配置持久化/拒绝、CodeGraph 与 diff 检查通过。

### 🐛 [PC 同步与执行前预检回归修复] - 2026-09-02

#### REQ-PC-PREFLIGHT-REGRESSION-001

- 修正 PC 实时同步中的失效 `uniquePromos` 变量引用，改为复用当前已分类的 `promoCards`，恢复 `/api/sync` 和 `/api/run` 的实时预检链路；
- 不改动 PC `/earn`、`/api/getuserinfo`、积分口径、Keep earning 分类或移动端代码；
- 增加失效变量回归断言；构建、54/54 相关回归、PC 隔离实例 HTTP 200 只读同步、CodeGraph 和 diff 检查全部通过。

### 🧩 [两端任务 ID 抗变化与执行口径统一] - 2026-09-02

#### REQ-ID-RESILIENCE-001

- PC Daily Set 日期解析不再限定 `Global_`，支持当前 `Gamification_` 和未来 `*DailySet_YYYYMMDD_ChildN` 前缀，同时对非法日期、混合周期和 preflight 不一致保持 fail-closed；
- PC Keep earning 的 Web 同步、机器人汇总、剩余积分与执行器统一复用共享官方集合分类器，当前 Daily Set、重复项和 Explore APP交互卡不会进入 PC 执行候选；
- 移动 APP交互卡继续显示并计入官方 More 上限，但执行器明确 `skip_manual_app_interaction` 且零 POST；Read 写入改用当前 `type=msnreadearn` promotion 的动态 offer ID，固定旧 ID 已删除；
- Punch Card 改为结构化 quest 链接、Dashboard child ID 和 hash/状态对象优先，`pcparent/pcchild/punchcard` 仅作安全兼容回退；
- 验证：构建、53 项回归、语法、定向 lint、固定 ID 扫描、SAAndroid 新 `Gamification` 三卡只读实测、CodeGraph 同步和 diff 检查全部通过。

### 📚 [CodeGraph 与接口注册表工作流] - 2026-09-01

#### REQ-DOC-CODEGRAPH-WORKFLOW-001

- 新增 `docs/API_INTERFACE_REGISTRY.md`，集中维护 PC/移动官方接口、本地 API、字段口径、终端边界、分类与完成规则、读写副作用、测试映射和未完全验证项；
- 删除人工维护的 `docs/CODE_LOGIC_TOPOLOGY.md`，函数、模块与调用关系统一由项目 `.codegraph` 实时索引；历史需求中的旧引用保留为历史证据；
- 更新项目开发流程 Skill：开发前查接口注册表并使用 CodeGraph 定位，测试前使用 `codegraph affected`，完成时强制 `codegraph sync/status`，不再手画调用拓扑；
- 验证：接口文档结构检查、Skill 校验、CodeGraph 查询/影响/测试映射、索引同步与 `git diff --check` 全部通过；本次未修改业务代码或接口行为。

### 🛡️ [官方任务动态归属防复发] - 2026-09-01

#### REQ-TASK-CLASSIFICATION-REGRESSION-001

- 固化任务分类优先级：当前官方集合和结构化属性优先，offer ID／标题命名只能作为安全回退，禁止用宽泛名称正则永久排除任务；
- PC Keep earning 分类抽取为生产与测试共用的纯函数，并增加“历史 Daily Set ID 被重新投放”行为级回归夹具；
- 行为测试覆盖当天 Daily Set 精确排除、历史式 ID 保留、Explore APP任务过滤和重复 offer 去重；任务状态回归由 20 项增至 21 项；
- 实时复核保持 PC `95/120`、移动 `95/195`，构建、36 项回归、真实 Chromium 渲染及终端隔离检查通过。

### 🐛 [PC Keep earning 官方积分对齐] - 2026-09-01

#### REQ-PC-KEEP-EARNING-OFFICIAL-001

- 修复 PC 按历史 Daily Set 命名正则误删官方 Keep earning 卡的问题；现在只排除同次响应中当天 Daily Set 的精确 offer ID；
- 当前恢复 4 张被微软重新投放的历史式任务，共 `80/80`，PC Keep earning 从 `15/40` 对齐为官方 `95/120`；
- PC Explore/`APP任务` 仍保持过滤，移动端保持 17 张、8 个 APP任务、`95/195`，两端数据域未串联；
- 验证：35 项回归、构建、Web/页面语法、两端实时同步、真实 Chromium 渲染、diff 与 CodeGraph 检查通过。

### ↩️ [恢复 PC Explore APP任务过滤] - 2026-09-01

#### REQ-PC-APP-TASK-FILTER-RESTORE-001

- 按用户最终确认恢复 PC 端原有边界：后端与页面过滤 `_exploreonbing_activation_`，PC Keep earning 不显示 `APP任务`，也不计入 PC More 小计；
- 移动端保持 8 张 Explore on Bing 卡及 `APP任务` 标记，不改变移动状态或积分口径；
- 实时验收：PC 14 张卡、APP标记 0、小计 `15/40`；移动 17 张卡、APP标记 8、主汇总 `95/195`；
- 验证：35 项回归、构建、页面/Web 语法、两端实时同步、真实 Chrome 渲染、diff 与 CodeGraph 检查通过。

### 🏷️ [PC Keep earning APP任务标记] - 2026-09-01

#### REQ-PC-APP-TASK-BADGE-001

> 此项历史变更已由 `REQ-PC-APP-TASK-FILTER-RESTORE-001` 撤销；当前 PC 不显示 APP任务。

- 恢复 Rewards Web 两个 More Promotions 集合中官方返回的 Explore on Bing 卡，继续按 offer ID 去重并排除 Daily Set；不从移动端复制任务；
- PC 卡复用 `isExploreOnBingTask`/offer ID 分类和共用 `APP任务` 胶囊，详情提示需要 Bing App 手动交互；普通 Quiz 不标记；
- 移除 PC 后端与页面的双重 Explore 隐藏，恢复卡按 Rewards Web 自身进度参与 PC More 小计，不影响独立的 `/earn` 官方今日累计或移动数据域；
- 验证：35 项回归、构建、页面/Web 语法、PC 实时对账、真实 Chrome 渲染、diff 与 CodeGraph 检查通过；当前 22 张 PC 卡中 8 张正确标记。

### 🏷️ [移动 More activities APP任务标记] - 2026-09-01

#### REQ-MOBILE-APP-TASK-BADGE-001

- 根据 SAAndroid 官方 `isExploreOnBingTask=True` 识别需要 Bing App 底部提示交互的 More activities，并兼容已验证的 Explore offer ID 回退；
- 特殊卡标题右侧新增蓝色 `APP任务` 胶囊，详情抽屉新增“需要 Bing App 手动交互”，普通 Quiz/URL Reward 不显示；
- 标记只描述执行方式，不改变任务完成状态、任务数量、积分口径或 PC 数据域；
- 验证：34 项回归、构建、Web/页面语法、实时 SAAndroid 同步、真实 Chrome 渲染、diff 与 CodeGraph 检查通过；当前 17 张卡中 8 张正确标记，Warpspeed quiz 标记数为 0。

### 🐛 [移动 More activities 逐卡状态纠正] - 2026-09-01

#### REQ-MOBILE-MORE-STATUS-001

- 修复 SAAndroid promotion 的 `State=Complete` 被误当成用户已完成的问题；逐卡状态现在只接受明确 `complete=True` 或积分进度达到上限；
- Web 同步、共用 `AppState.progressOf`、AppPromotions 执行前刷新及执行后复核使用同一完成规则，避免页面误打勾和执行器错误跳过；
- 实时对账当前 17 张 More activities，后端与原始 `complete/progress/max` 差异为 0：6 张完成、11 张待完成；截图中的 `Talk, text, save`、`Check options` 及另外两张冲突卡均恢复为待完成；
- 验证：TypeScript 构建、31 项相关回归、Web 语法、SAAndroid 全量逐卡对账、真实 Chrome 页面渲染、diff 与 CodeGraph 检查全部通过。

### 🧩 [两端任务弹性发现与移动 Daily Set 新 ID 兼容] - 2026-09-01

#### REQ-TASK-DISCOVERY-ELASTIC-001

- 移动 Daily Set 改用官方市场日期、offer ID、正分和任务属性识别，兼容当前 `Gamification_DailySet_*`、原 `Global_DailySet_*` 及未来同结构 ID；执行前后仍严格复核，不盲目接受未知任务；
- 移动 More activities 改按 `daily_set_date` 属性隔离，保留微软重新投放的无日期历史式任务；Explore on Bing 卡保留展示并计入上限、但不计入主汇总分子，实时接口与页面均对齐 Bing App 的 `13/17 完成、115/195`；PC More Promotions 保持独立契约；
- 两端新增 `additionalTaskSections` 弹性只读分区：新官方任务集合/type 自动独立展示，但未验证协议前不执行、不进入积分口径；PC 已实时发现 Punch Cards 分区；
- PC/移动页面为固定日志栏增加动态底部安全区，避免 More activities 和新增分区被遮挡；状态缓存协议升级至 v5；
- 验证：33 项相关回归、TypeScript 构建、页面/服务端语法、真实页面渲染（17 张卡、`115/195`）、移动实时只读对账、diff 与 CodeGraph 检查全部通过。

### 🎨 [PC/移动任务详情抽屉操作统一] - 2026-09-01

#### REQ-UI-DRAWER-ACTION-001

- 共用任务详情抽屉底部改为横向双按钮：“打开官方任务”与“关闭”按约 `2:1` 分配宽度、保持 `44px` 同高和 `12px` 间距，解决按钮黏连；
- “打开官方任务”为蓝色主操作，“关闭”为边框次操作；无安全官方 URL 时隐藏主操作并让关闭按钮占满底栏；
- PC Daily Set/Keep earning 与移动 Daily Set/App Promotions 复用同一交互，Edge 专用抽屉保持不变；
- 验证：任务状态回归 18/18、TypeScript 构建、页面脚本语法、运行中页面结构、diff 与 CodeGraph 检查全部通过。

### 🐛 [PC/移动 Daily Set 官方周期对齐] - 2026-09-01

#### REQ-DAILY-CYCLE-001

- PC Daily Set 改为从 Rewards Web Dashboard 当前三张 offer ID 解析官方活动日期，不再因 Mac/Docker 本地日期提前切换任务；
- 移动 Daily Set 独立使用 SAAndroid `markettime` 的市场日期，不继承 PC 周期，保留两端先后重置的真实行为；
- 同步、Preflight 和 PC/移动执行器均校验同一官方日期；日期缺失、含糊或运行前后切换时安全跳过，不执行相邻日期 offer；
- 实时对账验证 PC 为 `08/31/2026、3/3 DONE`，同时移动为 `09/01/2026、0/3 PENDING`；构建、43 项相关回归、Web 语法、定向 ESLint、diff 和拓扑索引检查全部通过。

### 🛡️ [后台同步降频与失败退避] - 2026-09-01

#### REQ-SYNC-RATE-001

- 空闲 PC/移动云同步由每 30 秒改为成功后每 5 分钟，失败按 1、2、5、10 分钟退避，减少持续 OAuth、Rewards Web 和 SAAndroid 请求；
- 自动化运行期间继续暂停后台同步，执行前 Preflight、执行后官方复核和本地 SSE 日志保持实时；
- PC 与移动手动同步增加相互独立的 15 秒前端/后端双重冷却，重复请求返回 HTTP 429 和标准 `Retry-After`；
- 独立实例验证两端首次同步 HTTP 200、100ms 后重复同步 HTTP 429；构建、38 项回归、页面/服务端语法和 diff 检查全部通过。

### 🐛 [移动 More activities 动态发现修复] - 2026-08-31

#### REQ-MOBILE-MORE-ACTIVITIES-001

- 修复移动同步与执行器只识别隐藏 Sapphire 历史项目、漏掉手机当前可见 `urlreward` 的问题；
- More activities 现在按 SAAndroid 当前响应动态读取项目数量、标题、分值、进度和完成状态，同时排除所有日期 Daily Set、隐藏、无资格、试用、说明及零分项目；
- 展示、汇总、执行门控和执行器统一使用同一口径；待办项执行前重新读取，继续通过 AppReward offer ID 提交并由 SAAndroid 复核；
- 实时验收显示 `Complete this puzzle 5/5` 与 `Do you know the answer? 5/5`，合计 `10/10`；移动主卡仍独立保持 `120/120`；
- 验证：构建、35 项回归测试、服务端/页面语法、实时 SAAndroid 只读对账和 diff 检查全部通过。

### 🧭 [PC/移动任务卡专属积分详情] - 2026-08-31

#### REQ-UI-POINTS-DRAWER-001

- 积分详情抽屉改为按 `platform + scope` 渲染，PC、移动端以及各任务卡不再共用 PC 今日积分；
- 总余额卡只显示账号余额和账本信息；两端今日卡分别展示 Rewards Web 与 SAAndroid 的官方口径及其任务分项；
- PC Search、移动 Search/Read/签到和动态 Daily Set、Keep earning/App Promotions 卡均展示自身进度、积分、状态与来源；
- 动态任务存在安全官方 URL 时可从详情打开；任务文本改用安全文本节点渲染，Edge Browsing 专属分钟抽屉保持不变；
- 验证：构建、33 项现有与新增回归测试、服务端/页面语法、真实页面状态渲染和 diff 检查全部通过。

### 🔄 [两端任务实时决策与官方复核] - 2026-08-31

#### REQ-LIVE-TASK-001

- 移动 Keep earning 的展示、汇总和执行门控统一改用 SAAndroid sapphire offers，不再混入 PC Rewards Web 的 Golfing/Panda 等卡片；
- 移动 Daily Set 按 `daily_set_date` 精确选择当前集合；PC Daily Set 不再回退相邻日期，也不再由 streak 强制打勾；
- PC Keep earning 新增有限三轮完整集合复扫，可发现本轮运行期间新增或解锁的卡片，同一 offer 不重复提交；
- Punch Cards、Search Perk 增加执行后微软官方状态复核，未确认完成时输出明确警告；
- PC 进程结束状态改用保存后的规范化 `tasks` 快照，兼容待办计数和 `allTasksDone` 同步从实时卡片重算；
- 验证：TypeScript 构建、12 项任务状态、8 项移动状态、9 项日志解析、2 项 UrlReward 回归、Web/页面语法、定向 ESLint、diff 检查及 PC/移动实时只读接口全部通过。

---

### 🐛 [移动端 Today’s points 字段语义修复] - 2026-08-31

#### REQ-MOBILE-API-001

- 修正把账号级 `level_info.todays_points` 直接映射为 Bing App Today’s points 主卡的错误；
- 移动主卡现在严格汇总当前账号日期 Daily Set、当前有效 Search offer 和 Read offer；
- Sapphire Check-in、streak、More activities 继续排除在主卡分子和分母之外；
- `level_info.todays_points` 保留为 `levelInfoTodayPoints/accountTodayPoints` 诊断字段，不再覆盖页面；
- 实时只读对账：手机 App `90/120`，项目 `/api/mobile/sync` 为 `90/120`，Search `60/60`、Read `30/30`、Daily Set `0/30`，诊断字段为 `137`；
- 验证：6 项任务/积分映射回归测试、5 项移动状态测试、TypeScript 构建、服务端语法和 diff 检查全部通过。

---

### 🐛 [移动端 Daily Set 执行修复] - 2026-08-31

#### REQ-AUTOMATION-002

- 修复移动端完整任务流明确关闭 `doDailySet`，导致执行结束后 Daily Set 仍为 `0/3` 的问题；
- Daily Set 调整为账号共享任务，PC 或移动入口均可串行执行；执行前按 Rewards Web 当天状态跳过已完成卡片；
- 移动端 Preflight 计划新增 Daily Set 的 `run_pending/skip_complete/skip_state_unavailable` 日志；
- PC Search、More Promotions、Punch Cards、Visual Search 等 PC 专属任务在移动模式下仍保持关闭；
- 采用最小增量修改，没有重写 Daily Set 执行器、同步接口或页面；
- 验证：实时只读同步、移动模式隔离、Preflight 计划、TypeScript 构建、服务端语法、定向 ESLint、11 项回归测试及 diff 检查全部通过。

---

### 🛡️ [接口契约与增量修改保护] - 2026-08-30

#### REQ-POLICY-001

- 在 `开发需求文档.md` 固化 PC `/earn`、Rewards Web、SAAndroid 的官方真值来源、项目字段映射、终端归属和失败处理规则；
- 已验证接口字段升级为受保护契约：没有官方页面、原始响应或可复现日志证明接口变化时，不得修改数据源或计算口径；
- 明确 PC/移动端只有总余额可共用，今日积分、任务小计、任务状态和执行权必须保持隔离；
- 强制后续开发基于现有代码做最小范围增量补丁，禁止局部需求引发整文件重写、整模块替换、整个页面重新生成或范围外格式化；
- 更新 `ms-rewards-development-workflow` skill，在实现前和交付前检查接口契约、最小 diff 及用户未提交修改保护；
- 验证：skill 官方快速校验、UI 配置解析、契约关键字段检查与 diff 检查全部通过。

---

### 🐛 [PC 官方今日积分对齐修复] - 2026-08-30

#### REQ-SYNC-002

- 修复 PC“官方今日总赚取”错误显示 PC 任务小计的问题；主卡现在直接使用 `/earn` 的 `EarnHeader_TodaysStat.data.totalPoints`；
- PC 专属任务小计继续独立保存在 `pcDailyEarned/pcDailyMax`，用于任务状态和执行计划；
- 当前实时对账：`/earn=102`、页面主卡已获取 `102`、动态总数 `132`、PC 任务小计 `65/95`；
- 同步日志现在同时输出“官方今日累计”和“PC 任务小计”，避免再次混淆两种口径；
- 验证：实时 Rewards Web 同步、TypeScript 构建、前后端语法及 11 项回归测试通过。

---

### 🔄 [独立状态同步与执行前任务门控] - 2026-08-30

#### REQ-SYNC-001 / REQ-AUTOMATION-001

- PC 与移动端同步保持两个独立按钮和两份状态；仅账户可用总积分共用，不再混合两端今日积分与任务；
- Web 服务运行期间每 30 秒并行刷新 PC Rewards Web 与移动 SAAndroid 官方快照，任务执行期间暂停后台同步以避免会话竞争；
- PC 同步新增真实 PC 任务积分、动态搜索配额、Daily Set、More Promotions、Edge Browsing 与 Punch Cards 状态，移除固定 `30/30`、`3/3` 和 Edge 假完成；
- 移动同步使用 SAAndroid 官方任务快照并单独保留各项目小计；原 `todays_points` 主卡映射已由 2026-08-31 后续修复条目纠正；
- 手动云同步失败现在返回 HTTP 503 和明确错误，缓存不再冒充同步成功；
- 两个执行入口在启动前强制实时 Preflight 并输出 `[PLAN]`，已完成项目使用 `skip_complete`，状态缺失使用 `skip_state_unavailable`；
- 移动端签到和阅读在产生 POST 前再次读取官方状态；阅读只执行真实剩余篇数，移动搜索缺失配额时不再默认执行 30 分；
- 账号级 Daily Set、More Promotions、Punch Cards 等默认由 PC 流程拥有，移动流程不重复执行。
- 验证：TypeScript 构建、前后端语法、定向 ESLint、PC/移动实时接口、30 秒自动同步、终端隔离、11 项回归测试全部通过。

---

### 📚 [开发流程规范] - 2026-08-30

#### REQ-WORKFLOW-001：统一需求与变更记录流程

- 将原自动化功能需求迁移并统一命名为项目根目录的 `开发需求文档.md`，作为唯一需求入口；
- 明确 `UI_DESIGN_SPEC.md` 只负责界面规范，`CUSTOM_CHANGELOG.md` 只记录已经开发完成且测试成功的变更；
- 新增全局技能 `ms-rewards-development-workflow`，自动约束“先登记需求 → 开发 → 实际测试 → 验收后记录变更”的顺序；
- 已通过技能官方快速校验、自动触发配置解析、旧路径清理与文档引用检查。

---

### 🌟 [v4.3.1-patch2.1.0] - 2026-08-26 (🔥 全新侧边栏导航 + 机器人推送面板 + 系统深浅色自适应)
#### 🛠️ 侧边栏架构与推送中心
- **可伸缩现代侧边栏 (Collapsible Sidebar)**：
  - 左侧常驻极简侧边栏，支持 `◀ 收起` / `▶ 展开` 自由伸缩与状态持久化。
  - 提供 **📊 控制中心 (Dashboard)** 与 **⚙️ 机器人与系统设置 (Settings)** 快速切换。
- **🤖 机器人推送通知中心 (Webhook Configuration)**：
  - **Discord 频道 Webhook**：一键开启并配置 URL。
  - **Telegram Bot 机器人**：支持 Bot Token 与 Chat ID。
  - **微信 / 钉钉 / 企微 / 飞书 机器人**：支持 Server酱 (SendKey)、PushPlus 及自定义 Webhook URL。
  - **🧪「一键测试推送」**：前端点击立即触发后端向目标机器人发送测试卡片，实时校验连通性。
- **⚙️ 自动化运行参数可视化配置**：
  - 可在 Web 界面自由调整搜索随机延时、新闻阅读延时，以及各项任务模块的启停开关，一键保存并写入 `config.json`。
- **🌓 系统级深浅色主题自适应**：
  - 自动跟随 macOS 深浅日夜模式，并支持右上角 `🌓` 手动切换与偏好记忆。

---

### [v4.3.1-patch2.0.0] - 2026-08-26 (里程碑：Fluent Web 控制台)
#### 🎨 微软官方 rewards.bing.com/dashboard 风格 B/S 网页端控制台
- **全新 Web 架构 (B/S)**：
  - 新增 [`web.mjs`](file:///Users/junzhuang/Antigravity/ms_rewards/web.mjs)、[`public/index.html`](file:///Users/junzhuang/Antigravity/ms_rewards/public/index.html) 与 [`web.sh`](file:///Users/junzhuang/Antigravity/ms_rewards/web.sh)。
  - 彻底根除终端 ANSI / Emoji 字符宽度造成的边框对齐缺陷，实现全设备像素级排版与响应式渲染。
- **100% 微软 Fluent Design 2 视觉复刻**：
  - 官方微圆角卡片、毛玻璃磨砂阴影、`Segoe UI` 现代排版与彩色状态徽章。
  - **官方 Points Breakdown 弹窗组件**：点击即可弹出与微软云端一致的积分来源细分与历史数据。
- **实时 SSE 事件流与一键控制**：
  - 支持「🚀 一键运行」、「🩺 环境体检」、「🛑 中途停止」，通过 Server-Sent Events 实现毫秒级任务打勾动画与彩色日志控制台。
- **macOS 原生防休眠整合**：
  - 启动 `./web.sh` 自动激活 `caffeinate -i -s -m` 守护，并自动唤醒默认浏览器打开 `http://localhost:3888`。

---

### [v4.3.1-patch1.7.0] - 2026-08-26
#### 📊 微软官方 Points Breakdown 弹窗数据 100% 结构化对齐
- **官方全字段数据直连**：
  - 从微软官方 `userStatus.counters` 提取 **`dailyPoint` (Today's points: 112分)**、**`activityAndQuiz` (Offers: 82分)**、**`pcSearch/mobileSearch` (Bing search: 30/30分)**。
  - 从 `levelInfo.progress` 提取 **`This month` (本月累计: 3,402分)**，从 `userStatus.lifetimePoints` 提取 **`Lifetime` (终生累计: 14,611分)**。
- **分类看板完美对齐**：
  - 重构 TUI 看板的“积分来源明细”行，与网页点击 `Points breakdown` 弹窗弹出的明细结构完全一致。
- **跨会话持久化与全天真实累加**：
  - 支持记录 `dayStartBalance`，即使多次开关脚本或死机重启，也能牢牢记忆全天总赚取增量。

---

### [v4.3.1-patch1.6.0] - 2026-08-26
#### 🌟 全量任务动态探查 (Task-Discovery) 与全类型活动通杀
- **全量预检调度流水线 (先探查，后执行)**：
  - 任务启动时新增 `TASK-DISCOVERY` 阶段，先向微软官方完整拉取今日待办总览（含 Daily Set、/earn 推广卡、搜索配额），生成任务清单后再按图索骥精准执行，彻底解决漏做漏领问题。
- **解除卡片类型限制 (通杀 Quizzes / Polls / Promotions)**：
  - 重构 [`PromotionActivityRunner.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/functions/activities/rewards/PromotionActivityRunner.ts)，移除了过时的 `if (type !== 'urlreward') return;` 白名单，将问答测验（Quiz/Trivia，如《Golf Legend》）、投票（Poll）与活动卡片统一通过 Next.js RSC `reportActivity` 自动结算。
  - 重构 [`MorePromotions.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/functions/activities/rewards/MorePromotions.ts) 的 `isActionable()`，移除了对 `promotional="True"` 属性的误杀，成功解锁并拿满如《Islands of adventure》（+10分）、《Ukiyo-e art 浮世绘》（+10分）等全部主题卡片，使 `/earn` 页面稳达 100% 满额（65/65分）。
- **跨时区日期 Key 安全解析**：
  - 重构 [`DailySet.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/functions/activities/rewards/DailySet.ts)，自动兼容微软美西时区（PST）与本地亚洲时区（UTC+8/UTC+9）的日期索引差异，避免因日期键不匹配导致的跳过。

---

### [v4.3.1-patch1.5.0] - 2026-08-26
#### 🎖️ 会员等级徽章 (Silver Member) 与月度升级进度追踪
- **会员等级与月度进度可视化**：
  - 在 [`src/index.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/index.ts) 的 `POINTS-BREAKDOWN` 中提取官方 `userStatus.levelInfo` 数据。
  - 看板顶部展示真实等级徽章（如 `Silver Member` / `Level 1` / `Level 2`）及当月升级进度（如 `月度: 3,349/750 分 (已达标)`）。
- **宽屏自适应与排版防折叠**：
  - 重构看板头部为双行优雅展示，解决多项字段挤占同一行导致的省略号截断（`...`）问题。
  - 扩充任务进度列宽，使单项积分 `(65/140分)` 与动态搜索主题完美对齐。

---

### [v4.3.1-patch1.4.0] - 2026-08-26
#### 🛑 冗余桌面会话剔除、跨端凭据注入与防卡死优化
- **智能按需启动桌面浏览器**：
  - 修改 [`src/index.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/index.ts)，在所有日常任务已完成时，自动跳过启动第二套 PC 桌面浏览器，避免在无头模式下陷入重复登录死循环。
  - 修复导致卡死 4 分钟并报 `Login timeout: exceeded maximum iterations` 的根本缺陷。
- **移动端 Cookie 跨端自动注入**：
  - 在 `createDesktopSession` 中自动注入手机端活跃 Cookie，实现秒级免登录直达。

---

### [v4.3.1-patch1.3.0] - 2026-08-26
#### 🩺 全方位健康自检工具 (Doctor) 与进程防锁死
- **全新自检脚本**：
  - 新增 [`doctor.sh`](file:///Users/junzhuang/Antigravity/ms_rewards/doctor.sh) 与 [`doctor.mjs`](file:///Users/junzhuang/Antigravity/ms_rewards/doctor.mjs)，支持一键排查构建产物、账号凭据、会话数据库、僵尸浏览器进程及微软云端网络连通性。
- **启动前自动清理孤儿进程**：
  - 看板启动首毫秒自动执行 `pkill` 清理残留的 Chromium 进程，彻底避免异常退出后的 Profile 文件锁死。

---

### [v4.3.1-patch1.2.0] - 2026-08-25
#### 💾 本地日终状态记忆 (Daily State Memory) 与商城积分分类
- **本地状态持久化存储**：
  - 新增 [`sessions/daily_state.json`](file:///Users/junzhuang/Antigravity/ms_rewards/sessions/daily_state.json)，每次点数或任务状态变动实时落盘。
  - **死机/重启防护**：开机启动后瞬间恢复当天进度与分类积分，无需等待网络轮询。
- **积分来源三维分类看板**：
  - 🎮 Xbox / 微软商城消费返利（Shop & Earn 大额积分对账）
  - 🔍 必应搜索配额（PC + 移动端上限）
  - 📋 日常活动与打卡（签到、每日三项、新闻阅读）
- **单项任务积分列**：
  - 任务列表中每一项增加独立点数列：`1/1次 (5/5分)`、`3/3次 (30/30分)`、`10/10次 (90/90分)`。

---

### [v4.3.1-patch1.1.0] - 2026-08-25
#### 🛡️ macOS 原生三重防休眠守护 (caffeinate)
- **多维度防休眠锁**：
  - 在 [`tui.sh`](file:///Users/junzhuang/Antigravity/ms_rewards/tui.sh) 与 [`run.sh`](file:///Users/junzhuang/Antigravity/ms_rewards/run.sh) 中注入 `caffeinate -i -s -m`：
    - `-i`：防止闲置休眠（允许屏幕熄灭/快捷键锁屏）。
    - `-s`：电源供电下防止深度系统睡眠。
    - `-m`：防止磁盘闲置挂起。
  - 脚本执行结束或按 `Ctrl+C` 时自动释放锁，恢复系统正常休眠。

---

### [v4.3.1-patch1.0.0] - 2026-08-25
#### 🖥️ 终端可视化控制台 (TUI Dashboard)
- **自适应与窗口尺寸锁定**：
  - 新增 [`tui.mjs`](file:///Users/junzhuang/Antigravity/ms_rewards/tui.mjs) 与 [`tui.sh`](file:///Users/junzhuang/Antigravity/ms_rewards/tui.sh)，通过 ANSI 与 AppleScript 自动锁定终端为 `106 列宽 × 36 行高`。
  - 采用 Visual Width 字符宽度算法，严格锁定 98 列安全框，实现右侧边框 `║` 绝对垂直对齐。
- **实时 Explore on Bing 主题同步**：
  - 实时捕获并中文显示当前正在搜索的推广卡片主题（如《演出门票》、《家庭宽带》、《租车自驾》）。
- **任务完成交互式驻留**：
  - 取消 1.5 秒自动关闭，任务跑完后看板常驻展示，按回车或 `q` 退出。

---

## 📂 定制文件与修改点清单 (File Modifications Map)

| 文件路径 | 变更类型 | 核心作用与修改内容 |
| :--- | :---: | :--- |
| [`tui.mjs`](file:///Users/junzhuang/Antigravity/ms_rewards/tui.mjs) | **[新增]** | 终端 TUI 看板引擎、事件流解析、本地状态读写与交互式退出 |
| [`tui.sh`](file:///Users/junzhuang/Antigravity/ms_rewards/tui.sh) | **[新增]** | 终端启动引导器（尺寸设置 106x36、`caffeinate -i -s -m` 守护） |
| [`doctor.mjs`](file:///Users/junzhuang/Antigravity/ms_rewards/doctor.mjs) | **[新增]** | 环境与健康全方位自检引擎 |
| [`doctor.sh`](file:///Users/junzhuang/Antigravity/ms_rewards/doctor.sh) | **[新增]** | 一键自检运行脚本 |
| [`src/index.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/index.ts) | **[修改]** | 注入 `POINTS-BREAKDOWN`、`TASK-DISCOVERY` 事件；优化桌面会话启动判定与 Cookie 同步 |
| [`src/functions/activities/rewards/DailySet.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/functions/activities/rewards/DailySet.ts) | **[修改]** | 跨时区字典安全定位，确保任务卡不错漏 |
| [`src/functions/activities/rewards/MorePromotions.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/functions/activities/rewards/MorePromotions.ts) | **[修改]** | 优化 `isActionable()`，移除对 `promotional="True"` 的误杀 |
| [`src/functions/activities/rewards/PromotionActivityRunner.ts`](file:///Users/junzhuang/Antigravity/ms_rewards/src/functions/activities/rewards/PromotionActivityRunner.ts) | **[修改]** | 移除 `urlreward` 类型限制，支持问答 (Quiz)、投票 (Poll) 等全类型卡片 |
| [`sessions/daily_state.json`](file:///Users/junzhuang/Antigravity/ms_rewards/sessions/daily_state.json) | **[新增/数据]** | 当日任务与积分持久化记忆存储文件 |

---

## 🔄 上游代码同步与升级指南 (Upstream Merge Guide)

当上游仓库（`TheNetsky/Microsoft-Rewards-Script`）发布了新版本（如 `v4.3.2`、`v4.4.0`）时，按照以下步骤安全合并：

1. **拉取上游最新代码**：
   ```bash
   git fetch origin
   git merge origin/main --no-commit
   ```
2. **检查核心修改文件是否有冲突**：
   - 对照上文“定制文件修改点清单”核对 4 个源码修改文件（`index.ts`、`DailySet.ts`、`MorePromotions.ts`、`PromotionActivityRunner.ts`）。
3. **重新编译并自检**：
   ```bash
   npm run build
   ./doctor.sh
   ```
4. **运行看板验证并打新 Patch 标签**（如 `v4.3.2-patch1.0.0`）：
   ```bash
   ./tui.sh
   ```
