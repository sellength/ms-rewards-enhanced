# MS Rewards 排障手册

## 搜索一次后持续等待 #sb_form_q 超时

- 2026-09-14（REQ-MOBILE-SEARCH-NAV-20260914）：移动 BrowserSearch 改为在原移动 page/context 直接导航官方 `/search?q=…`，不再依赖搜索框或每10次回首页；PC 保留原恢复逻辑。`strategy=mobile-navigation` 表示新提交分支，不能据此断言入账。导航超时、HTTP错误或非结果页停止且不重发，登录/验证要求检查；后续仍无积分增长时按同源 SAAndroid 进度及当次停止原因定位，不再归因于输入框缺失。源码编译与92项离线回归通过，未重启或真实执行。

- 21:49、22:14 真实日志出现 `page=bing-search`、搜索框可见却报 `search_manual_required:bing-search`：落地后首次检测短暂阻塞，紧接着错误检测恢复正常；另有普通结果页的无关 `challenge` iframe 可触发旧通用子串选择器。移动导航最多进行三次短间隔落地确认；验证检测只认明确 captcha 控件、登录控件或验证路径。一次瞬态或普通 challenge iframe 不停止搜索，持续验证仍停止。

- 后续00:48–00:49日志确认：page=bing-search、searchBoxes=0，回首页后再次获得5分。因此不是已证实风控；结果页缺少旧选择器，但实际替代入口尚未真机采样。新增 SearchPageAdapter：语义入口兼容、唯一可编辑候选、无入口直接首页回退；常规回退用中性info文案，不触发通用错误正则。折叠入口无可靠证据前不猜按钮。

- 2026-09-12：移动搜索成功一次后输入前连续5次等待可见搜索框超时，剩195分；旧重试只等待2秒，没有导航恢复。缺少当时页面证据，不能判定为地区、风控或关键词问题。
- REQ-SEARCH-RECOVERY-20260912：共用 BrowserSearch 在提交前失败后最多两次返回既有 Bing origin，继续使用原浏览器上下文；检测登录/验证/页面关闭则停止要求检查，不处理验证。已尝试 Enter 的结果不确定时停止，不重发。
- 失败诊断只输出 page 类别、searchBoxes、searchBoxVisible、submissionAttempted；不记录原始URL、查询串、正文或凭据。持续失败查看新诊断再定位，不无界重试。已通过离线模拟，不构成真机恢复或入账证据。

## PC Bing App Streak 显示 1/1 却没有完成徽章

- 原因：只读卡片未接入状态绘制，旧页面只更新签到文字；详情曾以包含 `1/1` 判断，可能误判 `1/10`。
- 修复：卡片和详情共用完整进度解析，每次同步重绘；不加入 PC 任务组，避免执行日志覆盖。缺少数据时清除旧进度并显示不可用。回归见 taskStatus.test.js；不需要重跑签到获取状态。

## 2026-09-09：大项执行中残留与移动 Daily Set 普通卡误跳过

- 大项 3/3 但仍 RUNNING：applyOfficialTaskStatuses 曾优先保留运行标志，忽略官方 DONE；改为官方 DONE 优先，并在回放绘制层应用相同优先级，防止重连反弹。不要等待整轮任务结束才更新已完成大项。
- 移动普通卡显示交互并跳过：BTEPOKey/BTROID 关联参数被误当作人工/测验充分证据；收窄分类并同步移除执行器仅凭 BTROID 判 quiz 的分支。明确投票/测验/人工条件仍保守跳过，未修改 More 分类器。
- 本地 75 项回归通过；真实入账尚未验证。分类单测通过不等于自动化协议成功，用户测试后仍需检查官方同 offer 状态。无需重试抓包或修改积分公式。

## 2026-09-08：任务运行中顶部积分停在执行前

- 原因：后台定时同步在 activeBotProcess 存在时跳过，worker 日志不是权威积分快照，页面直到最终同步才更新。
- 采用同端官方读取的事件触发+节流同步，保留最终同步。不要直接把日志余额差累计到今日积分；该路径此前可能造成口径跳变。
- 新增 liveRunSync 本地测试验证合并、串行、失败退避、收尾等待；连同状态/重连回归 51 项通过。不中断正在运行的旧服务；完成后重启加载，验收积分和任务进度是否随官方数据更新。
- 若官方入账延迟，继续读同 offer/同端接口，不以本地算分补齐。若同步失败，保留旧值并提示，不中止积分任务；回退只移除运行中刷新调度，不改变官方接口。

## 2026-09-08：关页面后后台运行现场丢失

- 原因：浏览器运行标志初始化 false，SSE 重连只发 PC 积分快照，不回放运行标志、子状态和日志；后台子进程仍存在，重复启动被拒绝。
- 修复路径：服务端缓存两端运行事件，重连发送 runtimeSnapshot，页面替换旧日志并恢复按钮。不要从积分推断“正在运行”，不要用 localStorage 代替后台进程状态。
- 本地验证：46 项相关测试通过（重复恢复、隔离、终态、日志上限、跨日）；未操作当前运行服务。需当前任务结束后重启服务，启动新任务后关页重开验证，现有旧服务没有缓存的日志无法补回。
- 缓存只存在服务内存，不写凭据文件；服务重启日志清空，不自动重启任何积分任务。

## 2026-10-02：账号触发 Fraud_UserWarning_BotScore_UX 安全跳过与处置策略

- 现象：任务日志输出 `[BOT-WARNING] Microsoft Rewards reported Fraud_UserWarning_BotScore_UX for ... This account will be skipped for safety.`，执行器主动跳过该账号，积分获取为 0。
- 根因：官方接口 `https://rewards.bing.com/api/getuserinfo` 返回的 `dashboard.userWarnings` 包含 `Fraud_UserWarning_BotScore_UX` 预警，表明该账号被微软 Bot 评分风控系统标记异常。
- 默认保护机制：程序默认策略为 `contintueOnBotWarning: false`，检测到该预警时主动跳过（安全熔断），防止自动化持续进行导致账号被微软正式限制或封禁。
- 已验证处置路径：
  1. 最佳方案（推荐）：暂停该账号自动化脚本 2~4 天，在真实手机 Bing App 或电脑 Edge 浏览器上正常手工搜索并完成 1~2 天基础签到，等待微软服务器端风控评分衰减自愈；
  2. 人机验证排查：在真实浏览器访问 `https://rewards.bing.com`，排查是否有黄色风控横幅或拼图人机验证（若有拼图，手动完成一次拼图有助于风控恢复）；
  3. 强行继续配置（高危不推荐）：若明确已知封号风险仍需执行，可在 `config.json` 设 `"contintueOnBotWarning": true`（或环境变量 `CONFIG_CONTINTUE_ON_BOT_WARNING=true`）。

## 2026-09-05：Rewards App only 锁定任务与人工任务不可混同

- 首选直接读取官方 `getuserinfo`，不是仅搜索本地已过滤的 promoCards。实测五张 RewardsApp offer 分类为 `rewardsApp`、状态为 `locked`、均 0/10；与 Explore 的 `category=tomorrow` 锁定是不同原因。
- 现有 `isAppInteractivePromotion` 的 `ww_moreactivities_rewardsapp_offer_` 前缀规则只是本地保守分类，不构成人工交互协议证据；SAAndroid 不是已确认替代通道。
- Windows 商店官方产品页：https://apps.microsoft.com/detail/9mw3cmw8jksd 。需同账号官方应用请求对照后再研究单项执行；不要仅删除 locked 检查或提交猜测 payload。当前没有成功计分证据，不重复使用 Daily Set 测验失败来证明这些不同任务无法完成。
- 只输出任务 ID、资格、进度等诊断白名单；不保存会话 Cookie、Token 或完整响应。本轮只读，未提交积分活动。

## 2026-09-05：展示为交互任务却仍自动尝试

- REQ-MOBILE-INTERACTIVE-SKIP-001：此前 Daily Set 分类仅用于展示，执行器未使用，造成标签与运行行为不一致。用户现确认逐卡跳过。
- 复用同步的 `isInteractiveDailySetDestination`，在最新官方完成检查之后、活动提交和导航之前返回 `skip_manual_app_interaction`；不要复用整个 More 栏目过滤器，也不要整组跳过。
- 本地混合卡测试验证交互卡零 POST/导航、普通卡继续；84 项回归通过。官方完成仍重读确认，不手动加分。无需抓包、账号凭据或真机测试跳过逻辑；回退只移除此执行门控，不改变分类数据和积分。
- 现行契约见 [接口注册表第 5.2 节](API_INTERFACE_REGISTRY.md)；本条为验证证据，范围仅为被识别的移动交互子卡。

> 目的：优先复用已验证的诊断和修复路径，减少重复遍历、无效抓包和反复试错。本文档只保存脱敏的方法与结论，不保存 Cookie、Token、邮箱、设备标识或完整抓包 URL。

## 按症状排查

- 先定位本手册相关症状；涉及字段和副作用时查 [接口注册表](API_INTERFACE_REGISTRY.md)，用源码搜索或按需 CodeGraph 缩小范围。
- 使用已有脱敏证据；需要新增证据时只采集诊断必要字段。可复现行为缺陷优先建立能覆盖原问题的回归，再做局部补丁；不强制文档或视觉小改先写失败测试。
- 验证按 [需求流程](../开发需求文档.md) 的风险与授权边界执行。本地替身能验证的门控不要求真实账号；只有约定验收确需且用户已授权时才执行最小真实任务，并同源复核。旧记录中的授权不自动延伸至新任务。
- 只补充新的可复用方法或失败止损证据，不重复已有探索链。

## 快速路由

### 2026-09-05：Edge Flyout 测验可答完但任务未计入（AI 可行性实测）

- 用户授权由 AI 在当前登录的 Edge 执行一张测验。任务入口为 Flyout 的 `Gamification_DailySet_20260905_Child2`（Show what you know，10 分）。
- 实际执行：读取当前三选一选项，依次选择 Eiderstedt Peninsula、Schleswig-Holstein Wadden Sea National Park、Salt marshes，经 Next 和 View result 进入官方结果页，显示 `You got 3 of 3 correct.`。
- 随即重新打开官方 Rewards Flyout，仍显示 Daily Set `0/3`、Show what you know `Offer not Completed`。本次证明 AI 可操作页面，未证明该浏览器链路能够完成奖励任务；未排除官方异步延迟，未用 SAAndroid 复核。
- 线索而非定论：入口 offer 日期为 20260905，而测验内容键为 `HPQuiz_20260904_Westerheversand`；答案导航可见 URL 中没有入口 BTROID。必须进一步检查官方请求和任务关联，不能仅凭 URL 推断关联丢失，不能直接篡改日期或补造计分参数。
- 同次观察：Daily poll 结果页显示 `The poll is closed`，两选项 disabled，但 Flyout 仍未完成；Explore 后四卡显示 `Available tomorrow`。这类不可操作状态不能通过 AI 答题解决。
- 推荐活动的宣传文案不能单独证明 Daily Set 的 10 分要求好友成功受邀，应分别核实两种奖励。
- 止损：不为同一测验持续重复答题，不用页面成绩代替任务完成，不在计分验收前把 AI API 配置宣称为解决方案。浏览器可复现时优先浏览器 Network 检查；本轮未配置 MITM、未连接手机、未获取完整计分 API。

| 症状 | 先查 | 已验证的结论/方法 |
|---|---|---|
| PC 今日积分变来变去 | `/earn` RSC、preflight/postflight 与 worker 诊断 | 主卡只认 `EarnHeader_TodaysStat.data.totalPoints`；执行器 `POINTS-BREAKDOWN/TASK-DISCOVERY` 只写日志，不得 `saveState` 覆盖权威同步快照 |
| 页面任务与官网完成状态不一致 | 同次官方卡片集合与规范化 state | 只认 `complete=True` 或进度达上限；`State=Complete`、HTTP 200、余额变化均不是完成证据 |
| 第二天首次打开仍显示昨日已完成 | 缓存键与两端官方日期 | PC/SAAndroid 可先后跨日；按 `account + platform + accountDate + schemaVersion` 隔离，不用宿主机日期互相覆盖 |
| PC Keep earning 出现官网找不到的任务 | 当前 Earn MoreActivities 子树与旧 getuserinfo 集合 | 先做精确 ID 交集；旧接口包含不代表当前展示或可执行。NFL 三项曾只在旧接口出现，不能据 ENUS 前缀推断地区限制。解析未知时零执行，不使用硬编码黑名单 |
| 移动 Today 与 Bing App 不一致 | SAAndroid `options=612` | 主卡 = 当日 Daily Set + 当前 Search + Read；`level_info.todays_points` 是范围更广的诊断值，不得覆盖主卡 |
| Mobile Daily Set 裸 POST 200 但不完成 | Rewards mini-app 完整桥调用链 + `MobileDailySet` | 裸 `type=101 + offerid` 缺少 App 生成的 `risk_context`、channel、加密 `meta` 和配套导航/事件上下文；destination 单独打开也不是完整协议。按当前动态 offer 构造完整链，最后只认同次 612 复核 |
| Daily Set 完整上报缺设备上下文 | `AppActivity` + `SessionStore` | 不绑定或复制真实手机 ADID；按账号生成并持久化不同的匿名 device/sapphire UUID，session ID 仅当前运行固定，RUID 取同次 SAAndroid profile。公共 RSA 公钥允许用 PEM/Base64 环境变量在 Docker 中轮换；缺任一上下文则单卡安全失败并继续后续任务 |
| Keep earning/More 人工任务无法通用 API 完成 | `requiresManualInteraction` + 官方完成字段 | 只在 Keep earning/More 分类：官方未完成时标记 `人工任务` 且执行层零通用提交；官方完成后只标记 `已完成`。完成与积分到账分开读取，禁止本地加分；Daily Set 不复用 More 分类器；自身交互子卡的标记与跳过按接口注册表第 5.2、8 节执行 |
| `Set a goal` 反复 UrlReward 200 但不完成 | Rewards `/goal` destination | 已证实必须用户选择兑换目标；标记人工任务并 `skip_manual_required`，不再重试 UrlReward/打开页面 |
| PC 同步/Preflight 失败但网页能打开 | 应用 Session、RSC/API 响应和超时 | 手动网页正常不代表应用保存的 Session 仍有效；若 OAuth 正常但 Rewards 读取接口均为 HTTP 400，检查是否把整份 storage-state Cookie 拼进请求头，必须按目标 URL 的 domain/path/secure/expiry 筛选。同步失败保留缓存并显式报 `*_cloud_unavailable`，不得改称成功 |
| 运行成功但整组任务显示异常 | SSE `recordTaskFailure` | 只将可推断出明确 taskId 的错误归属给任务；无归属警告不能回退标记所有计划任务 |
| Edge 正常上报却显示“异常” | Edge 进度日志与 `recordTaskFailure` | `failed=0` 是零失败计数，必须先从失败关键词判定中排除；只有正数失败计数或明确失败文本才能生成 `ERROR`。同时用 `status=200`、`accepted` 持续增加确认上报链健康 |
| Edge 日志数分钟没有新增，怀疑卡死 | `nextReportInSeconds`、子进程和最终官方状态 | Edge 常见每约5分钟上报；先计算下一窗口。上报 accepted、HTTP200、退出码0不证明官方30/30。新日志分开 edgeHubComplete 和 Web serverComplete；只有 Web 满额才是页面 DONE |
| EdgeHub 已完成而页面仍25/30 | 同次 Web 原始卡与 EdgeHub profile | 已实测两个来源不一致；保留Web25/30并记录待核实，停止继续上报，不声称完成或强制加5分钟。不凭标题/上报次数推断周期相同；后续同步读官方结果 |
| PC/手机任务日不同，刷新时间却一样 | taskRefresh 与旧 nextCycleEstimate | 旧实现统一显示浏览器下个零点，非微软重置时间。取消该推算；各端显示自己的官方任务日。无可靠官方重置时刻显示待确认；时间换算使用系统时区，但不得拿系统日期决定官方换日 |
| 点击执行后所有待办项同时显示“执行中” | SSE 启动广播与 worker 日志 | 预检只生成 `PENDING` 计划；不批量下发 `RUNNING`。仅在识别到对应 worker 的 `run_pending/Starting/Started` 日志后更新该 taskId，完成/结束日志及时离开运行态 |
| Daily Set 一项出错后三张卡全部标红 | `taskStatus.itemId` 与卡片 `offerId` | Daily Set 错误日志中的动态 offer ID 必须作为子状态键；组标题可汇总异常，但只有同 offer 的卡片标红，其他卡保持自身官方状态 |
| Mobile Daily Set Quiz 点击多次或 Poll 报 `options_unavailable` | 当次动态 destination 的页面/frame DOM 与 App 首次导航上下文 | 真机确认 `.b_ans` 是容器，不能点击；Quiz 必须循环“可见 `.acf-button-standard__link` 答案 → `Next`”，末题点 `View result`，Poll 只点一个可见答案。导航需使用 BingSapphire 通用 UA 与 App 路由参数；仍只以后续 `options=612` 同 offer 完成为成功 |
| Mobile Daily Set 日期/ID 正确但三项仍为 0 | 同周期真机 Rewards mini-app 首次导航与无头浏览器诊断字段 | `browserAppProfile=true`、`requestAppProfile=true`、Bing `_U` 存在仍不足以证明 App 原生上下文完整；若 `rewardsQuiz/rewardsPoll/rewardProgress=false` 且 `optionCount=0`，停止重试和猜测参数，按 WebView DevTools 方法采集同 offer 的原生首次导航、最终 URL、frame/DOM 和 612 结果后再改代码 |
| PC 日志出现 MOBILE worker | `executionContext` 和 active page | PC worker 必须包在 `isMobile=false` 上下文中，且使用存活的 desktop session；终端配置门控不能代替执行上下文隔离 |
| PC 同一 Punch Card 被尝试两次 | `Main` 调用链 | 只保留 `doPunchCardsDesktop()` 的桌面端路径，不再额外调用历史 `doPunchCardsMobile(data)` 入口 |
| Keep earning 执行很慢且多张卡0分 | `pointProgressMax` 与 `MorePromotions.isActionable` | 0 分卡是信息/导航项，不是可获取积分任务；保留展示，执行器直接跳过 |
| Preflight 显示 Edge `30/30` 但运行仍等待约 31 分钟 | Rewards Web 当前 Edge streak + `EdgeBrowsing.run` 入口 | 根因是 Web 计划已 `skip_complete`，子进程仍无条件启动后台上报。执行器必须在任何 App profile/写请求前复核当前 Web streak，完成即零请求返回；不要等待 App profile 再判断，因为两来源可能处于不同刷新阶段 |
| Keep earning 0 分/人工卡随整组变成“执行中” | 卡片 `points`、人工分类与 SSE 组状态 | 组状态不能覆盖不可执行子卡；0 分信息/导航卡不显示运行徽章，未完成人工卡保持“人工任务”，只有自动可执行的正分待完成卡继承 `RUNNING/ERROR` |
| 提示 Fraud_UserWarning_BotScore_UX 并跳过账号 | 官方接口 `userWarnings` 与 `contintueOnBotWarning` | 微软风控检测到自动化特征并下发预警，程序默认主动熔断跳过；首选暂停脚本 2~4 天使用真实浏览器手工搜索恢复，强行继续需设 `contintueOnBotWarning: true`（高封号风险） |

## 非 Root Android + Bing 诊断

只在安卓原生链诊断时阅读 [WebView 专册](MOBILE_WEBVIEW_DIAGNOSTICS.md)，设备步骤、证据边界与清理统一维护在那里。

- Bing 不信任用户 CA 时停止重复 MITM；无调试 socket 时停止自动写入推断。
- 只拦截 `navigate` 不能保证只读，卡片点击可能另行 `postHttp`；观察任务优先不点击，详见专册桥调用边界。

## 两端完整跑测的已验证判定方法

仅用于本次已授权的两端完整跑测；不是所有修复的必经步骤。单终端任务只验证该终端，文档修改不启动服务或 worker。

1. 先重启 Web 服务，确保运行的是最新 `dist` 和 `web.mjs`；测试监听 `/api/stream`。
2. 先跑 PC、等待 `finished code=0` 与 postflight 同步，再跑移动，避免两个进程竞争共享会话。
3. 验收看最终 `/api/state` 与 `/api/mobile/state`，不用运行中 worker breakdown 代替官方同步。
4. 进程退出码 0 只说明流程正常结束；最终官方仍为 `PENDING` 的手动/APP 交互任务必须保持待完成，不能因退出码改成已完成或异常。
5. PC 日志中为获取 App token 而出现的移动授权 bootstrap 不是移动积分 worker；终端隔离以 Daily Set/More/Punch/Search/Read/Check-in 等实际任务执行器的上下文判定。

## 新条目模板

```text
症状：
适用范围/版本：
官方真值来源：
根因：
已验证方法：
验证证据：
已知无效方法与止损条件：
失败回退：
隐私/环境清理：
最后复核日期：
```
