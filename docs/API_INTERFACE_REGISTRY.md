# API 与接口注册表

> 本文件是项目接口语义的权威注册表；`.codegraph/codegraph.db` 是代码、模块和调用关系的实时索引。二者共同替代已废弃的人工 `CODE_LOGIC_TOPOLOGY.md`。

## 1. 使用原则

- 查业务口径、终端归属、字段含义、完成判定和保护等级：先查本文件。
- 查实现位置、调用者、被调用者和影响范围：按需使用源码搜索或 CodeGraph，不在 Markdown 中复制调用图。
- 修改接口前先登记 `开发需求文档.md`，在本表核对受影响契约；不再维护需求文档的重复字段表。
- 官方响应结构发生变化时，只更新受影响的注册项、解析器和测试夹具；不得整文件或整模块重写。
- 本文件不得保存真实 Cookie、Token、邮箱、RUID、EPUID、MUID、设备序列号或抓包关联标识。

可选定位命令（依赖索引时确认新鲜度；不作为所有任务的必跑清单）：

```bash
codegraph query <symbol>
codegraph callers <symbol>
codegraph callees <symbol>
codegraph impact <symbol>
codegraph affected <changed-file>
codegraph sync .
codegraph status .
```

权威性顺序：官方同次响应中的当前集合归属 > 官方结构化属性 > 精确 offer ID 交集 > 名称或 ID 回退。名称、标题、日期前缀和历史 ID 都不是稳定类型系统。

## 2. 数据域与隔离边界

| 数据域 | 权威来源 | 可以共享 | 必须隔离 |
|---|---|---|---|
| 账户公共数据 | Rewards Web `userStatus`；SAAndroid `response` | 当前账号身份、可用总积分 | Token、Cookie、Session、设备指纹仍按账号和终端保存 |
| PC | Rewards Web `/earn`、`/dashboard`、`/api/getuserinfo` | 仅公共账户余额 | 今日积分、任务日期、任务集合、缓存、日志、运行状态 |
| 移动 | Rewards Platform `channel=SAAndroid` | 仅公共账户余额 | Bing App 今日积分、移动日期、Search/Read/Daily Set/More/Check-in、缓存、日志、运行状态 |

PC 与移动端可以先后跨日重置。手动同步互不触发；各终端完成结果必须由该终端同源复核，不复用另一端结果。任何执行计划都必须用当前入口的官方日期和 offer ID 重新预检；不得用宿主机日期或另一终端缓存替代。

## 3. 登录与运行授权接口

| 接口 | 方法 | 用途 | 主要实现/消费者 | 关键约束 |
|---|---|---|---|---|
| `/api/account/status` | GET | 返回是否存在可用 PC Web 与 SAAndroid 会话 | `web.mjs`；`public/index.html` | 未登录时任务入口禁用并显示登录页 |
| `/api/account` | GET/POST | 读取或更新账号配置 | `web.mjs`；设置页 | 不得回退到开发者邮箱；不得输出秘密字段 |
| `/api/account/logout` | POST | 删除当前账号登录信息并恢复未登录状态 | `web.mjs`；账号页 | 删除当前账号 sessions/account_metadata、ACCOUNT_1 配置及两端展示缓存，清空回放并广播 accountLoggedOut；保留其他账号与无关配置；任务或云读取中返回 409，清理失败返回 500；不调用微软接口 |
| `/api/account/login` | POST | 只建立/验证登录会话 | `web.mjs` → 授权子进程 | 登录模式必须禁用全部积分 worker，不得偷偷执行任务 |
| `/api/run` | POST | 启动 PC 任务 | `web.mjs` → `runBotProcess('desktop', state)` | 运行前强制实时 PC preflight；401/状态不可用时禁止执行 |
| `/api/mobile/run` | POST | 启动移动任务 | `web.mjs` → `runBotProcess('mobile', state)` | 运行前强制 SAAndroid preflight；不得触发 PC worker |
| `/api/stop` | POST | 停止当前运行进程 | `web.mjs`；两端按钮 | 同一时间只允许一个任务进程；停止后按原终端最终同步 |

## 4. Microsoft Rewards Web（PC）外部接口

### 4.1 页面与读取接口

| 官方接口 | 方法 | 用途与受保护字段 | 解析入口 | 主要消费者/验证 |
|---|---|---|---|---|
| `https://rewards.bing.com/earn` | GET（HTML/RSC） | `EarnHeader_TodaysStat.data.totalPoints` 是 PC 官方今日累计；同时提供 streak、Edge、活动卡和 quest 入口 | `BrowserFunc` RSC/HTML 抽取；`web.mjs:fetchLiveMicrosoftState` | PC 主卡、Edge、Punch Cards；必须与官方 Earn 页面对比 |
| `https://rewards.bing.com/dashboard` | GET（HTML/RSC） | Dashboard、当前 Daily Set、More Promotions、等级和计数器补充数据 | `BrowserFunc.getDashboardData`/React 快照；`web.mjs` dashboard fetch | PC Daily Set、Keep earning、等级；与 `/earn` 合并而非互相冒充 |
| `https://rewards.bing.com/api/getuserinfo` | GET JSON | `dashboard.userStatus.availablePoints`、`levelInfo`、Search counters、Daily Set/More collections | `web.mjs:fetchLiveMicrosoftState`; Rewards parser | 公共余额、PC Search、任务集合 |
| `https://rewards.bing.com/earn/quest/{parentOfferId}` | GET | Punch Card 子任务详情 | `PunchCards`、`ReactFunc` | 父/子任务执行前后复核；无法列出时安全跳过 |
| 当前 Rewards 页面的 Server Action | POST | 部分 UrlReward/Daily Set/More 活动提交 | `PromotionActivityRunner`/`UrlReward`/React action resolver | Action 标识必须从当前页面解析，不固化旧值；提交后读取官方状态验证 |

### 4.2 PC 字段与分类契约

| 功能 | 当前口径 | 解析/选择器 | 执行器 | 保护与风险 |
|---|---|---|---|---|
| PC 官方今日累计 | `/earn` 的 `totalPoints` | `fetchLiveMicrosoftState` | 只读 | `officialAccountTodayEarned/dailyEarned` 必须固定对应官方累计，不能被任务小计覆盖 |
| PC 任务小计 | 当前 PC Search + Daily Set + More Promotions | 同次 PC 规范化快照 | 只读 | 只写 `pcDailyEarned/pcDailyMax`，不得覆盖官方今日累计 |
| PC 可用总积分 | `dashboard.userStatus.availablePoints` | `fetchLiveMicrosoftState` | 只读 | 余额变化不是任务完成证据 |
| PC Bing App Streak 展示 | PC 官方 Earn `partner=bingapp` 的 `complete/total`，现有 `appCheckIn` 字段 | `desktopAppCheckInStatus` 卡片与详情共用 | 只读 | 完整解析非负整数进度且分母大于0，达到目标显示完成，否则待完成；缺失/非法显示不可用。不用字符串包含 `1/1`，不继承 PC 执行状态，不用移动快照覆盖 |
| PC Search | `userStatus.counters.pcSearch` 动态 `pointProgress/Max` | Rewards parser / `SearchProgress` PC 分支 | `SearchManager` | 不得硬编码 30/60/100；执行前后同来源复核 |
| PC Daily Set | 当前 Dashboard 三张 Daily Set 的精确 ID 与日期 | `resolveOfficialDailySetDate`、Daily Set collections | `DailySet` | 解析任意当前 `*DailySet_YYYYMMDD_ChildN` 结构，已兼容 `Global_`、`Gamification_` 和未来前缀；日期非法、无法唯一确认或与 preflight 不同则安全跳过。疑似交互 Daily Set 同样采用入口尝试后复核：仅导航一次，最多3次间隔3秒的官方回读，每次通过新 Web 快照核对周期；不答题/投票，不通用提交 |
| PC Keep earning | 当前 Earn MoreActivities 子树 ID 与两个旧 Web More 集合交集去重，排除当前 Daily Set 精确 ID | `earnKeepEarningIds`、`selectPcKeepEarningPromotions`、`isManualKeepEarningPromotion` | Web 同步、机器人汇总、`getBrowserEarnablePoints`、`MorePromotions` | 所有生产调用都提供当前 Earn ID 集合，解析 `Earn.MoreActivities/moreactivities` 子树及 RSC 引用；旧列表只补字段，不扩大集合。不按 NFL 等名称排除。解析失败 unknown 与明确空集区分，Web 失败保留缓存、执行器零提交；未知集合不得回退旧列表。保持原有 App/Explore 过滤、人工门控和积分公式。仅在 Earn 有、旧接口缺少详情的卡暂不执行，不能拼造 metadata |
| Edge Browsing | `/earn` 结构化 Edge `complete/total` 为页面官方进度；EdgeHub completion 仅为停止上报信号 | Earn/React streak parser、`edgeWebProgress` | `EdgeBrowsing` | Web 已完成仍零上报。禁止使用 mobile 快照兜底 PC 完成；停止后单次 Web 回读，未满额/不可用记录待核实，由后续同端同步继续确认，不无限重报。保留原始分钟；`serverComplete` 专指 Web 满额、`edgeHubComplete` 独立记录。进程退出或上报次数不能推定 DONE；未建立周期对应关系，不用 Web 剩余分钟截断 EdgeHub 计划，上报计划与官方累计不是同一计数 |
| Punch Cards | `/earn/quest/{id}`、`quest_{id}` 父任务链接 + quest 当前子任务对象；Dashboard `punchCards` 用于精确 ID 交集 | `ReactFunc.snapshotQuestList/snapshotQuestPage` | `PunchCards` | 结构化链接、已知 child ID 或带 hash/状态的子对象优先；`pcparent/pcchild/punchcard` 仅为无结构证据时兼容回退 |

## 5. Rewards Platform（移动端）外部接口

所有 SAAndroid 请求统一经 `src/functions/activities/app/AppRequest.ts:buildAppHeaders` 构造；必须包含运行时 Authorization、通用非个人设备 UA、AppId、Country、Language、IsMobile 以及协议常量 PartnerId/Flights。协议常量不是个人设备指纹。

| 官方接口 | 方法 | 用途 | 解析入口 | 写入/消费者 | 保护与验证 |
|---|---|---|---|---|---|
| `https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=612` | GET | 移动主任务、余额、等级、Search、Read、Daily Set、More、`level_info` | `BrowserFunc.getAppDashboardData`; `web.mjs:fetchLiveMobileState`; `AppState` | 移动同步与各任务 pre/postflight | 移动任务权威真值；禁止复用 PC 响应或旧周期缓存 |
| `.../dapi/me?channel=SAAndroid&options=2` | GET | Sapphire Check-in 与 streak counters | `BrowserFunc.getAppEarnablePoints`; `web.mjs` | `DailyCheckIn` | 必须按 SAAndroid 账号日期查当天 counter；前一天记录不能代表完成 |
| `.../dapi/me?channel=SAAndroid&options=1` | GET | Profile/基础账号资料 | `BrowserFunc` | 登录/资料辅助 | 不是今日任务真值，不得替代 612 |
| `.../dapi/me?channel=SAAndroid&options=105` | GET | App Profile + catalog（当前主流程不依赖） | 无主流程依赖 | 诊断保留 | 不得因“数据更多”替换 612 |
| `https://prod.rewardsplatform.microsoft.com/dapi/me?channel=edge&options=Profile,Promotions` | GET | EdgeHub Profile/Promotions，停止上报条件 | `EdgeBrowsing` | PC Edge/诊断 | 不得混入 SAAndroid Today 主卡；该接口 complete 不能覆盖 Earn 分钟数或直接生成页面 DONE |
| `https://prod.rewardsplatform.microsoft.com/dapi/me/activities` | POST | Daily Check-in `type=103`；App offer/Daily Set 的 `type=101` 活动上报 | `DailyCheckIn`、`AppActivity`、`AppReward`、`ReadToEarn`、`MobileDailySet` | 移动写入 | 仅对通过第 5.2 节门控的普通 Daily Set 卡使用运行时 country、`risk_context`、channel、`sapphire-id`、运行期 `session-id` 与 RSA 加密 `meta`，并与 destination 页面交互配套；RUID 来自同次响应，设备/sapphire ID 为本地按账号持久化的不同匿名 UUID。HTTP 200、余额变化均不足以判完成，必须重新 GET 同 offer/counter |
| SAAndroid promotion 的动态 Bing `destination`（`https://*.bing.com/search` 或 `/rewards/checkuser?ru=...`） | GET + 页面交互 | Mobile Daily Set URL offer、Quiz、Poll 的原生导航与页面交互 | `MobileDailySet` | 移动 Daily Set 专用处理器 | REQ-DAILYSET-OPEN-FIRST-20260914：疑似交互 Daily Set 仅打开可信 destination 一次并同源回读，不提交活动、不答题/投票；普通卡继续既有原生协议链。destination 是真实调用链的一部分，不保证仅导航就完成。不得拼接 ID/日期/查询词；解码后的 `BTDSUOID/BTROID` 必须与当前 offer 精确一致，最后重读 `options=612` 同日期同 offer 验证 |
| `https://www.bing.com/search` | GET | 正常 Bing 搜索执行 | Search classes | `BrowserSearchOnBing`/`SearchManager` | 移动 BrowserSearch 在原 page/context 直接导航 `/search?q=…`，不依赖输入框、不添加 App 来源或活动参数；导航成功不代表计分。执行门控与验证只看当前 SAAndroid Search offer |
| `https://www.bing.com/rewardsapp/reportActivity` | 请求 | Rewards Web 搜索活动上报兼容路径 | `BingSearchApi` | 实验/网页流程 | 不能宣称为已确认的 Bing App 原生 API |

### 5.1 Bing App Today’s points 固定公式

```text
todayEarned  = 当前移动 Daily Set earned + 当前有效 Search earned + Read earned
todayMax     = 当前移动 Daily Set max    + 当前有效 Search max    + Read max
```

- `officialAppTodayEarned`、`todayEarned`、`mobileTaskEarned` 使用同一 earned 公式；`todayMax/mobileTaskMax` 使用同一 max 公式。
- 公共余额读取 SAAndroid `response.balance`；PC 与移动等级／月度进度分别读取各自 `levelInfo/level_info`，不使用固定示例数值。
- `level_info.todays_points` 只保存为 `levelInfoTodayPoints/accountTodayPoints` 诊断字段；它可能包含更广的账号活动，不能覆盖移动主卡。
- Check-in、streak、More activities 不加入该分子或分母。

### 5.2 移动任务分类与完成契约

移动进度统一 `pointprogress ?? progress`、`pointmax ?? max ?? points`，显式 0 不回退；共同完成函数只认 `complete=true` 或正上限已达。Daily Set 同步与执行均排除 `hidden=true/give_eligible=false`。任务读取统一 612，AppActivity Profile 另读 1；不据此断言 613 无效或二者普遍等价。

| 功能 | 选择规则 | 完成规则 | 主要执行器 | 特别约束 |
|---|---|---|---|---|
| Search to earn | `type=search` 且匹配当前等级/资格的有效 offer | `complete=True` 或进度达上限 | `SearchManager` | 不得用 Rewards Web `mobileSearch` 门控，也不得累加历史/试用 Search |
| Read to Earn | `type=msnreadearn` | 优先 `pointprogress/pointmax`，兼容 `progress/max` | `ReadToEarn` | 写入 offer ID 必须来自同次当前 promotion，缺失则零 POST；精确 App 原生 payload 语义仍待安全复测 |
| Mobile Daily Set | `markettime` 决定账号日期；同 `daily_set_date`、有 offerid、正分、合资格 | 每张卡执行前后重读同日期同 offer；只认明确完成或进度达上限 | `MobileDailySet`；完整原生链兼容仍待下一周期验收 | 每卡重读官方状态，完成优先 `skip_complete`；以 `isInteractiveDailySetDestination` 识别疑似交互卡（BTEPOKey/BTROID 单独存在不构成交互依据；人工属性 true、PollScenarioId、rqpiodemo=1、可信推荐路径为候选）。按 REQ-DAILYSET-OPEN-FIRST-20260914 先核对官方周期，打开可信同 offer 入口一次，零活动 POST、零答题/投票；每隔3秒最多回读3次，同日期同ID明确未完成才标需要交互，失败/缺失/跨日为待核实。普通卡继续现有专用处理器，按可信动态 destination 与 offer 关联校验及 App `meta` 契约执行；禁止整组跳过。不得使用裸 AppReward、真实手机设备 ID、Keep earning/More 人工门控或 PC 数据；缺少必要动态上下文时单卡安全跳过 |
| Sapphire Check-in | `options=2` 当天 `DailyCheckIn_SapphireYYYYMMDD` counter | 当天 counter 存在 | `DailyCheckIn` | `type=103` 后重读当天 counter |
| More activities | 当前可见、合资格、正分、无 `daily_set_date` 的 `urlreward`；兼容同条件 `sapphire` | 只认明确 `complete=True` 或进度达上限 | `AppPromotions` | `State=Complete` 是投放状态，不是用户完成；历史 DailySet 式 ID 仍可属于 More。排除安装说明、TrialUser、Impression、隐藏、无资格、零分、配置及归档项；分母保留全部合资格可见卡，Explore/App 交互卡保留展示但进度不加入 More 主汇总分子（现有 `requiresAppInteraction` 分支）；不得借整理改变此口径 |
| 人工任务 | 只在 Keep earning/More 集合中应用 `isManualKeepEarningPromotion`；包括 `isExploreOnBingTask`、受控 App ID、Rewards `/goal` 或明确人工属性 | 同所属 Keep earning/More 官方完成字段；完成和积分到账分开判断 | PC `MorePromotions` 用 `skip_manual_required`；移动 `AppPromotions` 对 App 交互保留 `skip_manual_app_interaction` | 官方未完成时零通用提交；展示规则统一见第 8 节。栏目小计、今日积分和公共余额只消费官方同步值，不本地累加；Daily Set 不复用 More 分类器，采用本节自身的逐卡策略；展示文案见第 8 节 |
| 未知动态任务 | 合资格但未命中已知分类的正分项 | 只读官方状态 | 不执行 | 放入 `additionalTaskSections`，不得污染已知项目积分口径 |

### 5.3 非 Root 安卓诊断入口

Bing/Rewards 不信任 PCAPdroid MITM 用户证书时，不再重复尝试 HTTPS 解密。标准诊断方法、WebView DevTools 连接步骤、失败判据和隐私清理见 `docs/MOBILE_WEBVIEW_DIAGNOSTICS.md`；PCAPdroid 在该场景仅用于连接/域名观察。

## 6. 本地 Web 控制台接口

| 接口 | 方法 | 平台/用途 | 状态与副作用 |
|---|---|---|---|
| `/api/state` | GET | PC 当前状态 | 读取 `latestDesktopState`/当天 PC 缓存；不触发任务 |
| `/api/sync` | GET/POST | PC 手动或静默同步 | 拉取 Rewards Web；保存会话中的 Cookie 必须按每个目标 URL 的 domain/path/secure/expiry 筛选，禁止整库拼接造成请求头过大；失败必须返回 `desktop_cloud_unavailable`，不能把缓存称为实时成功 |
| `/api/mobile/state` | GET | 移动当前状态 | 读取 `latestMobileState`/当天移动缓存；不触发任务 |
| `/api/mobile/sync` | GET/POST | 移动手动或静默同步 | 拉取 SAAndroid；不得触发 PC 同步或任务执行 |
| `/api/stream` | GET SSE | 两端日志、状态和任务状态事件 | 事件必须带 `platform + taskId`；动态子卡可额外带 `itemId=offerId`，仅更新对应卡片；诊断日志不持久化且不得输出秘密 |
| `/api/config` | GET/POST | 读取/更新可公开配置 | 密钥字段必须脱敏；写入使用校验与最小 patch；`display.timeZone` 暂作为旧配置向后兼容字段保留，首页与设置页不再读取或写入它 |
| `/api/test-webhook` | POST | Webhook 配置测试 | 仅显式点击触发；不得泄露完整目标秘密 |
| `/api/doctor` | POST | PC 环境监察 | 输出当前检查日志，不执行积分任务 |
| `/api/mobile/doctor` | POST | 移动/SAAndroid 环境监察 | 输出当前检查日志，不执行积分任务 |
| `/api/cache/clear` | POST | 全端/单端会话深度净化与重同步 | 彻底清理 `sessions.db` 中的 `_RwBf`/`ispd` 降速标记与跟踪脏 Cookie，保留核心登录凭据，并自动发起纯净云端重同步 |

## 7. 状态、缓存、同步和事件契约

- 桌面与移动分别使用 `latestDesktopState`、`latestMobileState`；账号总余额可共享，任务状态不可互写。
- 缓存按 `account + platform/channel + accountDate + schemaVersion` 隔离，并只作为当天降级展示；下一账号日必须失效。
- 手动同步按终端独立限流，当前冷却为 15 秒；被限流返回 429。
- 运行提示（REQ-RUN-SYNC-FEEDBACK-20260911）：页面运行中允许点击既有同步路由，不启动/停止任务；同页同端请求未结束时抑制重复点击。独立显示同步中/成功/失败/冷却，同步失败不把执行灯改红。运行汇总只读同端官方任务与运行事件：Daily Set/More按正分子卡（ID去重）计数，搜索/阅读/签到/Edge等按项目计数；人工/交互未完成单列，关闭项不计，未知项注明。不是积分口径，不依据进程退出判全部完成。灰色未开始、黄色闪烁运行、官方确认全部完成绿色、结束仍有待办黄色常亮、明确执行错误红色。运行中即便当前卡都完成仍黄灯，防止掩盖尚未结束的后台流程。
- 后台同步基准周期为 5 分钟；任务繁忙时 1 分钟；失败退避为 1/2/5/10 分钟。页面旧的 30 秒轮询不得放大为重复云请求。
- 云同步失败可保留缓存供显示，但必须标识缓存与失败原因，不能更新为云端成功时间。
- `taskStatus`/SSE 的组级状态键为 `platform + taskId`，Daily Set 等动态子卡使用 `platform + taskId + itemId(offerId)`；状态值为 `PENDING/RUNNING/DONE/ERROR/UNAVAILABLE/DISABLED`，PC 与移动同名任务不能互相覆盖。执行计划只初始化待办状态，不得在整场运行启动时把全部计划项批量设为 `RUNNING`；只有匹配到具体 worker 的开始日志才进入运行中。只有可推断出明确 `taskId` 的失败日志才可标记对应任务；带 offer ID 的 Daily Set 失败只标记同 offer 卡，无归属通用警告不得标记全部计划任务。进程退出码为 0 且无明确错误时，最终官方 `PENDING` 必须保持待完成；只有明确错误或非零退出才可升级为 `ERROR`。任务组运行状态只允许下发到该组未完成、正分且可自动执行的子卡；0 分信息卡和未完成人工卡不得显示 `RUNNING/ERROR`。
- `REWARDS_MODE=desktop/mobile` 是执行副作用的硬边界：desktop 禁止移动 Search/Read/Check-in/App Promotions/Mobile Daily Set；mobile 禁止 Edge、PC Search/Daily Set/More/Punch Cards/Activate Search Perk/Visual Search/Streak Protection/PC Bonus Claim。不能只依赖配置预处理关闭 worker。
- PC worker 还必须在 `executionContext.isMobile=false` 中执行并使用存活的 desktop page/session；否则即使终端配置门控正确，仍可选到移动页并记录 `MOBILE` 副作用。移动流程不发布 PC `POINTS-BREAKDOWN/TASK-DISCOVERY` 日志。
- 运行进程输出的 `POINTS-BREAKDOWN/TASK-DISCOVERY` 是执行器诊断快照，不是 Web 权威状态源；SSE 可展示其日志，但不得用其调用 `saveState` 或覆盖 preflight/postflight 同步结果。
- PC More Promotions 中 `pointProgressMax <= 0` 的官方信息卡只展示，不进入积分执行候选；PC Punch Cards 只调用一次 desktop 执行器，不叠加历史 mobile-named 入口。
- PC 的 `dailySetQuota/promotionsQuota`、pending 数和 `tasks` 必须每次从同一份规范化 `dailySetCards/promoCards` 快照派生，不能保留旧缓存分母。
- 执行前刷新官方状态：完成使用 `skip_complete`；状态不可用使用 `skip_state_unavailable`；配置关闭使用 `skip_disabled`。
- 任务结束或停止后进行同终端最终同步，确保页面反映真实官方状态。
- 搜索提交（REQ-SEARCH-RECOVERY-20260912、REQ-MOBILE-SEARCH-NAV-20260914）：PC BrowserSearch 保留输入框及提交前最多两次首页恢复；移动分支直接导航官方搜索地址，查询词作为单个 q 参数编码，继续使用原移动会话。登录、明确 captcha/验证路径或关闭页停止提示；普通结果页内名称含 `challenge` 的无关 iframe 不作为验证证据。Enter 或导航已尝试的请求不自动重复，移动非结果页落地或 HTTP 错误停止本轮。两端配额来源、查询生成和完成判断保持原口径；失败诊断采用安全类别与计数，不输出完整页面URL。移动导航真实计分待验收。
- 搜索兼容层（REQ-SEARCH-ADAPTER-20260912）：SearchPageAdapter 仅在 HTTPS Bing 域名解析唯一可见可编辑入口，优先 #sb_form_q，再采用搜索表单 q 字段或明确搜索语义输入。多个候选停止猜测；没有入口立即进入既有限次首页恢复，正常回退日志不包含 failed/error 避免误报任务异常。尚未验证的折叠按钮不自动点击。输入后积分仍按原终端官方接口复核。
- `allTasksDone` 只能由同次规范化官方任务快照汇总，不得由执行进程硬编码或依据“进程正常退出”推断；`POINTS-BREAKDOWN` 不负责宣称任务全部完成。
- 任务刷新提示（REQ-TASK-REFRESH-SOURCE-20260910）：各端同步输出 `taskRefresh={source,accountDate,nextResetAt}`，source 分别为 rewards-web/saandroid，accountDate 为该端官方任务日。当前未确认可靠精确重置字段，两个读取器显式返回 nextResetAt=null，而不是从日期/markettime/宿主机零点推算。页面显示该端任务日及“下次刷新待官方确认”。未来接入经过验证的官方重置时刻时，必须为带时区的 ISO 时间，且来源匹配、未过期，才转换到浏览器系统时区显示。系统时区只负责格式化，不决定官方周期；不读取 display.timeZone，不改变任务日期门控和积分公式。任务日不是更新时间，不以缓存中的 currentDate 替代。

### 7.1 运行中同步（REQ-LIVE-RUN-SYNC-001）

- 仅 desktop/mobile 积分运行启用：完成/进度日志触发同端现有官方 fetch/save 与 state/mobileState 广播。日志只是刷新提示，不可写入余额、今日积分或完成真值。
- 连续事件 2 秒合并，前次请求结束后至少间隔 30 秒；60 秒兜底触发处理遗漏和入账延迟。失败保留快照、日志警告并按 60/120/300 秒退避；单会话最多一个同步请求，不阻断 worker。
- 子进程退出时清理兜底计时器、取消待执行刷新、等待在途请求结束，再执行既有最终同步。空闲定时同步规则不变，不更新另一端；登录流程不启用此机制。

### 7.2 本地运行现场恢复（REQ-RUN-RECONNECT-001）

- `/api/stream` 每次连接先发送 PC `state`、`mobileState`，再发送 `runtimeSnapshot`。快照按 desktop/mobile 分开包含 running、tasks（组/子卡最新事件）、logs、action、countdown；后续 `runState` 和 `finished` 更新运行标志。
- 仅服务端内存保留，每端当天最近 2000 条运行期间日志；快照替换客户端日志而非追加，避免断线重复。后端重启清空，不恢复假执行中；关闭网页不影响缓存。跨日保留活动会话，清除旧日志。冷却按事件时间扣除离线时长。
- 该快照不是官方积分或完成来源，不修改两端既有积分状态接口。新运行清理旧任务事件；结束清除遗留 RUNNING。结束同步期间仍保持进程占用，避免新运行与旧收尾串线。

## 8. 页面消费与详情抽屉

- 同端官方 `tasks[taskId].status=DONE` 优先于历史 RUNNING/ERROR 与 SSE 回放，同步时清理该大项旧子状态；其他未完成大项保留自身运行状态，不从部分子项推算整组 DONE。
- `public/index.html` 只消费对应终端 API 的状态，不在前端重新推断完成状态或重新计算另一套积分口径。
- 总积分和今日主卡是聚合指标，不生成伪任务卡。
- 每张真实任务卡展示官方分值、状态和归属；详情抽屉只展示该卡自身数据。
- Keep earning/More 人工卡在官方未完成时展示 `人工任务`，官方完成后只展示 `已完成`；PC 仍过滤 Explore/Rewards App 专属卡，但保留并标记 Rewards goal 类 PC 人工卡。移动 More 中已识别的交互卡保持“交互任务/已完成”二态。两端 Daily Set 的 `requiresAppInteraction` 仅代表入口尝试后同源回读仍未完成的本地建议，不再由静态分类直接赋值；显示“需要交互/已完成”，`entryProbeResult=unverified` 显示“待核实”。建议按账号、端、官方任务日期、offer ID 在服务内存隔离（上限500，重启清空），官方完成优先，不覆盖官方完成或积分；重新尝试和未知结果清除旧建议。同步、运行事件与重连回放提供建议，旧缓存中的静态交互标记读取时重算。交互卡不继承组级运行/异常徽章，详情与卡片状态一致。Daily Set 不使用 `requiresManualInteraction` 或 More 整组门控；普通 Daily Set 与 PC 状态规则不变。页面验收缺口仍见需求索引，不能因本条登记视为已验收。
- 动态未知栏目使用 `additionalTaskSections` 弹性展示，但默认只读、不自动执行、不计入已知栏目汇总。

### 8.1 卡片全态契约与安全跳过策略（REQ-CARD-TAXONOMY-AND-SKIP-POLICY-20260930）

#### 1. 卡片状态机与展示契约
- **Explore on Bing（必应探索）**：
  - `tomorrow_locked`（`🔒 明天激活`）：包含 `unlocks tomorrow`、`category: tomorrow` 或 `status: locked`，微软次日时间锁；
  - `pending_activation`（`⏳ 待激活`）：今日开放但尚未展开抽屉激活，等待唤起；
  - `activated`（`⚡ 进行中`）：已展开抽屉，等待由 AI 意图引擎执行对应语义搜索；
  - `completed`（`✔ 已完成`）：进度达到 10/10，官方已结算。
- **Daily Set（每日必做）**：
  - `quiz` / `poll` / `url`：基于官方 subtype 与 offerid 解析题型；
  - `requiresAppInteraction`（`👆 需要交互`）：入口打开后同源回读未入账，需人工答题/投票；
  - `entryProbeResult=unverified`（`⏳ 待核实`）：入口正在探测确认中；
  - `complete`（`✔ 已完成`）：官方布尔确认已完成。
- **Keep Earning（更多活动）**：
  - 渠道徽标：`Web专属`、`App专属`、`Web通用`；
  - 任务状态：`🔒 明日解锁`、`👤 人工任务`（如 `/goal` 类不可自动提交卡）、`⏳ 待完成`、`✔ 已完成`。

#### 2. 自动化执行中的 6 大安全跳过策略（Skip Policies）
| 策略代码 | 触发场景 | 官方/内部条件 | 执行动作与安全理由 |
|---|---|---|---|
| `skip_tomorrow_locked` | 明天激活/次日解锁 | `isTomorrowLockedPromotion=true`（含 `unlocks tomorrow`、`status=locked`） | **跳过**。微软云端时间未到，提前强刷 0 分且极易触发风控 |
| `skip_complete` | 已完成/配额拿满 | `complete=true` 或进度达上限或搜索配额 `remaining<=0` | **跳过**。已获全部分数，杜绝重复提交 |
| `skip_cooldown_reached` | 云端冷却/配额熔断 | Explore 达每日 40 分上限，或连续 2 次意图搜索增加为 0 | **跳过**。触及微软每日软顶或冷却，自动熔断保护账号 |
| `skip_manual_required` | 需人工交互/App原生功能 | 标记 `manualOnly`、`/goal` 目标卡、原生硬件环境卡 | **跳过**。防止使用虚假协议提交导致被标记异常 |
| `skip_non_point_tasks` | 0分商业广告推广卡 | `skipNonPointTasks=true` 且 `pointProgressMax=0` | **跳过**。无积分商业推广，不浪费请求资源 |
| `skip_safety_guard` | 风控警报/会话异常 | 命中 `UserWarning`/`bot warning` 或数据源不可用 | **跳过**。安全第一，遇风控立即熔断，不顶风作案 |

### 8.2 Web 控制台访问安全与 AI 凭据目标地址契约

1. **监听与网络绑定契约**：
   - 默认强制绑定 `127.0.0.1` 本地回环接口，不向公网暴露端口；
   - 强制校验 `Host` 请求头：只接受 `localhost`、`127.0.0.1` 与 `[::1]`，杜绝 DNS Rebinding 攻击；
   - 禁用通配符 CORS：废除 `Access-Control-Allow-Origin: *`，非同源 Origin 请求一律返回 403 拒绝。
2. **会话认证与防 CSRF 契约**：
   - 首次访问 `GET /` 时下发 `ms_local_token`（`HttpOnly; SameSite=Strict; Path=/`）；
   - 敏感读写接口要求携带该 Cookie，所有写操作（`POST`/`PUT`/`DELETE`）强制校验请求头 `X-CSRF-Token`；
   - 认证失败或 CSRF Token 缺失时返回 401/403，无任何长期 Token 暴露在 URL 或日志中。
3. **AI 凭据与目标端点强绑定契约**：
   - **禁止覆盖目标地址提取已保存密钥**：调用 `/api/ai/test` 或 `/api/ai/fetch-models` 时，若未提供新 Key 且使用 Profile 保存的 Key，请求的 `baseUrl` 与 `provider` 必须与数据库中已保存的目标地址完全一致，否则服务端直接拒绝（HTTP 400）；
   - **端点协议与防 SSRF 校验**：目标地址必须使用 `https:`（仅本地回环 ollama/lmstudio 允许 `http:`）；
   - **禁止跨主机跟随重定向**：HTTP 请求采用 `redirect: 'manual'`，遇 3xx 重定向立即中断，杜绝重定向盗取 Authorization 头；
   - **日志与错误回显脱敏**：任何返回与日志中绝对不回显 API Key 明文。

## 9. 分类器、解析器与测试注册

| 契约 | 核心实现 | 直接测试 |
|---|---|---|
| PC Keep earning 选择与去重 | `promotion-classification.mjs:selectPcKeepEarningPromotions` | `scripts/api/taskStatus.test.js` |
| PC Daily Set 日期 | `src/util/DailySetCycle.ts` | `scripts/api/dailySetCycle.test.js` |
| SAAndroid Search/Read/Daily Set/More | `src/functions/activities/app/AppState.ts` | `scripts/api/appState.test.js` |
| SAAndroid 公共请求头 | `src/functions/activities/app/AppRequest.ts` | `scripts/api/appState.test.js` |
| 两端路由、平台状态与任务事件 | `web.mjs` | `scripts/api/taskStatus.test.js` |
| PC UrlReward/Server Action | `UrlReward`/React parser | `scripts/api/urlReward.test.js` |
| 独立任务失败隔离 | `src/util/TaskIsolation.ts` | `scripts/api/taskIsolation.test.js` |
| 运行日志到状态 | `scripts/api/logParser.js` | `npm run test:log-parser` |

改变某项行为时运行该项直接契约测试，并按影响选择补充验证；文档修订无需业务测试。CodeGraph 可辅助定位和选测，不替代源码核对，也不是每项任务的验收门槛。

## 10. 已知缺陷与未完全验证项（2026-09-07 整理，未新增业务验收）

以下项目不得因文档登记而被视为已修复。近期分类、运行同步、重连与接口一致性变更的本地测试记录及真实页面/计分验收缺口见 [需求文档](../开发需求文档.md) 中对应 REQ；不在本表重复测试流水。

- 2026-09-10 任务读取路径已统一 612，Profile 另读 1；待新周期真实业务回归，不能据此推断 613 无效。
- PC Earn 中存在但旧接口没有详情的新增卡目前不自动执行；当前精确交集修复不等于完整原生 Earn 字段迁移。
- EdgeHub 与 Earn 的周期/累计关联仍未知；Web 25/30 和 EdgeHub complete=true 的冲突必须保留，不得伪造官方30/30。

1. **固定 ID 已由 `REQ-ID-RESILIENCE-001` 修复，协议仍待验证**：Read 状态只按当前 `type=msnreadearn` 选择，写入使用同次 promotion 的动态 offer ID；但精确 App 原生 payload 语义仍未完成安全真机验证。
2. 已确认 Rewards mini-app 的 `meta` 明文结构为当前 RUID、毫秒时间戳、模拟器标记、空经纬度和设备标识，再使用原生 `Features/apiKeys.redeemPublicKey` 做 RSA 加密；项目已实现按账号持久化匿名设备/sapphire UUID，并允许通过 PEM 或 Base64 环境变量覆盖公共公钥，仍待下一周期安全写入验收。HTTP 200 或余额变化不能作为完全对齐证明。
3. 部分 Check-in 日期路径仍依赖宿主机 `new Date()`；必须统一改为 SAAndroid 账号日期。
4. **2026-09-03 真机协议已确认，但 2026-09-04 独立自动化验收失败**：可见 Rewards mini-app 通过原生 `requestBrowser` 首次打开当次动态 destination；内部浏览器使用 BingSapphire UA 与 `PC=SANSAAND/ssp/safesearch/setlang` 路由上下文。09/03 真机逐项完成后，612 同 offer 分别变为完成；但 09/04 无头浏览器即使日期、offer ID、UA 和公开路由参数正确，URL 仍不入账且 Quiz/Poll 不渲染奖励控件，612 保持 `0/30 PENDING`。因此这些公开参数只是必要上下文，不是可替代 App 原生导航的充分条件；在取得同周期真机 WebView 对照前，不得宣称独立自动化可完成 Daily Set。旧通用 `type=101 + offerId` 继续禁用；缺少可信 destination、ID 不一致或奖励控件未出现时仍安全失败。

已修复的 ID、分类器和 Punch Cards 事项见 [REQ-ID-RESILIENCE-001 历史记录](archive/REQUIREMENTS_2026-09-06.md#REQ-ID-RESILIENCE-001)。交互卡零提交的本地验收不证明普通卡原生自动化已成功。

## 11. 维护规则

1. 新增或改变外部接口、本地路由、核心字段、完成规则、终端归属或执行副作用时，先登记需求，再更新本注册表对应行。
2. 纯内部重命名且接口语义未变时，不为同步文件名而机械修改本表；CodeGraph 会提供最新符号关系。
3. 实施流程见 [开发需求文档](../开发需求文档.md)；代码关系按需使用源码或机器索引，不维护人工拓扑。
4. 发现新官方任务类型时先进入只读未知分区，保存脱敏证据并补充分类夹具；确认语义后才允许加入自动执行和积分汇总。
5. 已验证接口口径变化时更新本表对应行、需求中的证据与验收记录、直接测试；全部约定验收成功后再写变更记录，不复制第二份契约表，也不在文首追加覆盖正文的修正规则。
