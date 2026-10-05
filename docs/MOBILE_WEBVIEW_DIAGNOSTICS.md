# 非 Root 安卓 Bing Rewards 诊断方法

本文规定本项目排查 Bing App（SAAndroid）任务跳转、页面交互和完成状态时的首选方法。目标是避免每次重新尝试已经证实不可行的 HTTPS 中间人解密方案。

## 已确认的边界

- 测试对象是用户自己已登录、已授权调试的安卓设备和 Bing App。
- 非 Root 设备上，Bing/Rewards 当前不信任 PCAPdroid MITM 安装的用户 CA。日志出现 `client does not trust the proxy certificate`、TLS handshake failed，或 Bing 显示网络错误时，应立即停止 MITM，不重复安装证书或反复重试。
- PCAPdroid 在此场景只用于观察域名、连接时间和流量方向；不要宣称它可以解密 Bing HTTPS。
- 首选 Android WebView DevTools 通道。它检查 Bing App 自己已加载的 WebView 页面、DOM、跳转 URL 和交互结果，不绕过 TLS，也不要求 Root。

## 标准流程

1. 用 USB 连接安卓手机，打开开发者选项和 USB 调试；手机弹出授权时由用户确认。手机必须保持解锁，Bing 必须位于前台；锁屏/AOD 下 WebView 会进入 `visibility=hidden`，此时强制导航或点击得到的结果不得作为任务协议证据。
2. 确认 ADB 只连接到本次用户指定的设备：

   ```sh
   adb devices -l
   ```

3. 若 PCAPdroid 正在以 VPN/MITM 模式运行，先停止采集，确认系统不再有其 VPN；否则 Bing 可能因证书校验失败而无法联网。
4. 打开 Bing App 的 Rewards 页面，并在电脑检查 WebView 调试 socket：

   ```sh
   adb shell cat /proc/net/unix | grep webview_devtools_remote
   ```

5. 选择属于 Bing 进程的 socket，并只转发到本机回环端口。下面的 `<socket>` 和 `<port>` 必须替换为当次实际值：

   ```sh
   adb forward tcp:<port> localabstract:<socket>
   curl http://127.0.0.1:<port>/json/list
   ```

6. 从 `/json/list` 中选择 URL/标题属于当前 Rewards mini-app 的目标，通过返回的 `webSocketDebuggerUrl` 使用 Chrome DevTools Protocol 读取页面 URL、DOM和必要的交互结果。任务跳转必须由用户在真实 App 中触发或由同一 WebView 的正常点击触发。
7. 任务完成后回到 Rewards 页面，并以项目的 SAAndroid `options=612` 读取同账号日期、同 offer ID 的官方状态。只有 `complete=True` 或进度达到上限才算成功；页面跳转、HTTP 200 或余额变化均不能单独作为完成依据。

## Daily Set 诊断要点

以下点击与协议步骤仅适用于已授权的真机诊断，不是生产执行策略。生产交互卡按 [接口注册表](API_INTERFACE_REGISTRY.md) 第 5.2 节零提交跳过；不得为重现旧实验而自动解除门控。

- 不猜测或拼接 offer ID、日期、查询词和地区域名，全部使用当次 SAAndroid promotion 提供的动态 destination。
- destination 必须是 Bing HTTPS 搜索地址，并且 URL 内的 `BTDSUOID` 或 `BTROID` 与当前待执行 offer ID 精确一致。
- 真机由 Bing 正常接管 destination 后可能动态补充 `ssp`、`safesearch`、`setlang`、`cc`、`PC=SANSAAND` 等公共导航参数；经真机确认的固定 App 路由常量可进入专用执行器，语言/地区仍按账号或当次响应生成，但这些参数本身不得作为完成依据。
- URL offer 通常在首次正常加载后完成；Quiz 需要完成当前页面返回的题目；Poll 需要选择一个选项。
- 2026-09-03 真机已确认，URL offer 必须从可见 Rewards mini-app 的卡片经 `sapphireBridge.navigate`/`requestBrowser` 首次打开；对已打开页面执行 reload 不等同于原生首次跳转。内部浏览器公开路由特征为 BingSapphire App UA，以及 `PC=SANSAAND`、`ssp=1`、`safesearch=moderate`、`setlang`（地区参数由 App/Bing 当次决定）。
- 当前 Quiz 页面每题的可选答案为 `.acf-button-standard__link`；选择后必须点击文本为 `Next` 的 `button.acf-button-standard__btn`，末题点击 `View result`。`.b_ans` 是整张答案容器，不得当作选项点击。Poll 选择一个当前可见且可用的 `.acf-button-standard__link` 即可。
- 每张卡执行前后都重新读取 SAAndroid 状态，避免把缓存、另一日期或 PC Daily Set 当成移动结果。
- 2026-09-04 纠正：卡片点击处理器会并行/连续触发多个原生桥调用。即使临时拦截 `sapphireBridge.navigate`、阻止浏览器跳转，点击本身仍可能通过 `sapphireBridge.postHttp` 上报活动并让官方任务完成。因此“只拦截 navigate 后点击卡片”不是只读操作；诊断桥调用时必须同时拦截并审计 `navigate`、`postHttp` 和事件调用，或完全不点击。
- 已脱敏确认真实活动请求使用 `/dapi/me/activities`、`type=101`、当前动态 offer ID、运行时 country、`risk_context`、channel 与加密 `meta`。`meta` 由当前 RUID、时间戳、设备上下文经原生 `Features/apiKeys.redeemPublicKey` 加密生成；禁止记录真实 RUID、设备 ID、Token、完整 headers 或完整 `meta`。

## 失败判据与回退

- 没有 WebView 调试 socket：记录为“当前 Bing 构建未开放 WebView 调试”，不尝试 Root、证书固定绕过或修改 App。
- destination 缺失、不是 Bing HTTPS 地址、或不包含当前 offer ID：安全跳过并记录具体原因，不发送通用 AppReward。
- 页面结构无法识别或操作后官方状态不变：保持待完成，记录任务类型和匿名化错误；不得循环点击或无限重试。
- 当天任务已因人工或诊断点击完成：停止写入测试，记录“无法在同周期验证未完成 → 完成”，等待下一账号刷新周期；不得用重复提交、余额差或已完成响应代替验收。
- 若 `dumpsys window` 显示 `NotificationShade` 或电源状态为 Dozing，先请用户解锁并把 Bing 切到前台；不要使用 ADB 绕过锁屏，也不要把锁屏期间的 `No internet`、`ERR_NAME_NOT_RESOLVED` 或隐藏页面结果归因到任务接口。
- 三星设备可能把当前线缆报告为 AC powered 而非 USB powered；若调试期间需要临时防锁屏，应先读取 `dumpsys battery` 再选择正确的 stay-on 类型，并在调试结束后恢复为关闭。不得永久修改用户的锁屏策略。
- 需要更深入的原生网络协议分析时，必须另行取得可复现证据和用户授权，不把个人抓包内容提交进源码。

## 隐私与清理

- 文档、测试夹具和提交内容不得保存设备序列号、邮箱、RUID、EPUID、MUID、Token、Cookie、完整抓包或账号活动快照。
- 调试结束后删除本机端口转发：

   ```sh
   adb forward --remove tcp:<port>
   ```

- 本地诊断导出文件继续受 `.gitignore` 和 `.dockerignore` 保护；准备发布前按 [开发需求文档](../开发需求文档.md) 的隐私约束及其 REQ-RELEASE-PRIVACY-001 历史证据复核。
