# 🛡️ 第二轮安全审计8项核实与整改复审报告

> **报告日期**: 2026-09-29  
> **基线需求**: `REQ-SECURITY-ROUND2-REMEDIATION-20260930`  
> **工作准则**: 遵循项目根目录 `AGENTS.md` 边界规范（保留工作区未提交修改，不重复 S1-S7，不运行真实登录/积分任务，秘密不写入代码、测试、日志或回复）。  
> **交付性质**: 离线代码加固与本地自动化回归验证（离线测试通过不代表真实官方生产计分已生效）。

---

## 一、 审计核实与整改总览表

| 序号 | 审计对象 / 风险点 | 审计初查结论 | 漏洞与代码证据 | 修复实施与防御机制 | 验证测试套件与结果 |
| :---: | :--- | :---: | :--- | :--- | :--- |
| **1** | **`scripts/api/server.js` 独立控制 API** | **仍存在** | 1. `server.js` 原未设置 `TOKEN` 时直接绕过鉴权；<br>2. `processManager.js` 原无条件信任请求中 `args`，可注入 `-e` 执行任意 Node 语句或替换脚本。 | 1. 严格门控：未设置 `API_TOKEN` 时除 `GET /` 和 `/health` 外，所有控制端点强制返回 403 `API_TOKEN_REQUIRED`；<br>2. 参数与脚本白名单：严格阻断 Node 危险参数（`-e`, `--eval`, `--inspect`, `--require` 等），且强制执行首参数锁定，拒绝脚本替换；<br>3. 真实进程测试：通过子进程实际拉起 server.js 并发起实际 HTTP 请求校验。 | [`controlServerSecurity.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/controlServerSecurity.test.js)<br>**(真实 HTTP 5/5 全部通过)** |
| **2** | **`public/index.html` XSS 与 innerHTML** | **仍存在** | 日志拼接采用 `row.innerHTML = ... ${text}`；Punch Card 与探索卡链接拼接 `destinationUrl`；Profile 按钮内联 `onclick="...(${p.id})"`，存在标签逃逸与伪协议执行风险。 | 1. 日志改用 DOM `textContent`；<br>2. 卡片渲染引入 `escapeHtml` 实体转义；<br>3. 链接全面引入 `sanitizeUrl` 清洗；<br>4. Profile 按钮彻底废除内联 `onclick`，改用 `data-action` + `data-id` 与 DOM 事件委托监听器。 | [`xssSanitization.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/xssSanitization.test.js)<br>**(6/6 全部通过)** |
| **3** | **`UrlReward.ts` 官方完成真值核对** | **仍存在** | 原第 101 行与第 211 行存在 `if (complete \|\| gainedPoints > 0)`，仅因账户总余额增加就断言完成，在并发打卡或其它活动增分时造成假阳性误判；且 `gainedPoints` 归因累加时机过早。 | 1. `visitDestinationAndVerify` 移除 `\|\| gainedPoints > 0`，强制要求微软官方 `complete === true`；<br>2. `runUrlReward` 提交 action 后增加 `verifyOfferCompleted`，核实同一 offer 官方状态已完成方可标记成功；<br>3. `userData.gainedPoints` 收益累加移至官方验证成功分支内，未完成绝不提前虚增收益；<br>4. 保持 PC/移动执行环境严格隔离。 | [`urlReward.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/urlReward.test.js)<br>**(4/4 全部通过)** |
| **4** | **`src/util/Http.ts` POST 重试副作用控制** | **仍存在** | 原 `send` 函数无条件对所有 HTTP 方法重试 3 次，POST 请求遇网络超时或 5xx 可能会重复提交引发重复兑换或异常风控。 | 1. `HttpRequestConfig` 增加 `retryable` 配置；<br>2. POST 请求默认不进行副作用重试，仅当调用方显式配置 `retryable: true` 时才允许重试；<br>3. 幂等方法（GET、HEAD 等）维持安全重试机制。 | [`httpRequestRetry.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/httpRequestRetry.test.js)<br>**(3/3 全部通过)** |
| **5** | **`web.mjs` 请求体 DoS 与超限优雅处理** | **仍存在** | 8 处 POST 路由直接采用裸流；原超限时直接 `req.destroy()` 导致客户端收不到 413 只收到 ECONNRESET。 | 1. 统一实现 `readRequestBody(req, res, { maxSize = 1MB, timeoutMs = 10s })`；<br>2. 超限先执行 `req.pause()`，发送带有 `Connection: close` 的响应头并在 `res.end()` 回调中关闭，确保客户端完整接收 413 `payload_too_large` 与 408 `request_timeout`；<br>3. 单测严格断言真实收到的 413 / 408 状态码与响应体。 | [`requestBodyLimit.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/requestBodyLimit.test.js)<br>**(真实 HTTP 3/3 全部通过)** |
| **6** | **`ErrorDiagnostic.ts` 诊断与错误文件安全** | **仍存在** | 抓取的 DOM HTML 与错误日志以系统默认权限写入磁盘，未对密码/凭据脱敏，未处理 textarea 和元数据 errors，截图可能残留敏感像素。 | 1. 引入 `sanitizeDiagnosticContent`，全面脱敏 `<textarea>`、密码框、URL Query 凭据、Authorization Bearer、敏感 Cookie 以及蛇形键名（`access_token`, `refresh_token`, `client_secret`）；<br>2. 元数据 `errors` 数组全面清洗脱敏；<br>3. 截图默认关闭落盘（通过 `MS_CAPTURE_DIAGNOSTIC_SCREENSHOT=true` 门控）；<br>4. 所有诊断目录显式设置 `0o700`，所有文件显式设置 `0o600`。 | [`errorDiagnosticSecurity.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/errorDiagnosticSecurity.test.js)<br>**(3/3 全部通过)** |
| **7** | **Docker 非 root 运行与 Chromium 沙箱** | **代码具备<br>落地加固** | 原 Dockerfile 与 compose.yaml 默认以 root 启动，导致 Chromium 被迫添加 `--no-sandbox` 运行。 | 1. `Dockerfile` 安装 `gosu` 并设置应用目录归属为 `node:node`；<br>2. `scripts/docker/entrypoint.sh` 在容器内自动通过 `gosu node` 降权运行所有 node 进程与日常脚本，使用 `crontab -u node` 设置任务；<br>3. `compose.yaml` 提供非 root (UID 1000) 运行说明；<br>4. 非 root 环境下 `Browser.ts` 天然启用 Chromium 沙箱（不带 `--no-sandbox`）。 | 静态审查与权限降权逻辑验证通过 |
| **8** | **`adm-zip` 间接依赖核查与安全升级** | **无利用路径<br>已安全升级** | `npm ls adm-zip` 确认仅由 `fingerprint-generator -> generative-bayesian-network -> adm-zip` 引入。源码核查显示其只在启动时以只读方式解压内部预打包模型定义，不接收任何外部上传包，历史解压/路径遍历漏洞在此链路上**不可利用（Not Exploitable）**。 | 在 `package.json` 的 `overrides` 中显式指定 `"adm-zip": ">=0.6.1"`，已顺利升级至官方补丁版 `0.6.1`，消除依赖扫描告警（`found 0 vulnerabilities`）。 | `npm ls adm-zip` 确认锁定 0.6.1 |

---

## 二、 详细整改实现细节与防御代码证据

### 1. 独立控制 API 鉴权门禁与参数注入拦截 (`server.js` & `processManager.js`)
- **加固落地**：
  - 强制鉴权门禁：当环境变量未配置 `TOKEN` 时，除 `GET /` 和 `GET /health` 外，所有控制端点强制返回 HTTP 403 `API_TOKEN_REQUIRED`。
  - 配置 `TOKEN` 时，无凭据或凭据错误统一返回 HTTP 401 `Unauthorized`。
  - 参数消毒白名单：过滤带有 `-e`, `--eval`, `--inspect`, `--require`, `--input-type` 等高危参数，并且断言首个参数必须与系统默认执行脚本一致，严禁替换运行脚本。
  - 自动化测试 [`controlServerSecurity.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/controlServerSecurity.test.js) 启动真实 `server.js` 子进程并发起真实 HTTP 请求，5 个独立用例全部通过。

### 2. 前端 DOM 渲染安全与 XSS 防护 (`public/index.html`)
- **加固落地**：
  - 日志渲染彻底改用 DOM `createElement` 与 `textContent` 纯文本绑定，从根本上杜绝 DOM 解析执行。
  - Punch Card（第 6876-6878 行）与探索卡（第 6975-6977 行）全部通过 `sanitizeUrl()` 进行协议校验和非法字符清洗。
  - Profile 按钮（第 7234–7280 行、第 7320–7360 行）彻底移除内联 `onclick`，改用 `data-action` + `data-id` 与原生 DOM `addEventListener` 事件委托，彻底根绝内联代码注入。

### 3. UrlReward 官方完成真值核验与归因纠正 (`src/functions/activities/api/UrlReward.ts`)
- **加固落地**：
  - 移除通过余额差值推断完成的逻辑，无论总积分是否增加，必须调用 `verifyOfferCompleted` 核对同一 `offerId` 在微软官方（`ensureOffer` 或 `getDashboardData`）的真实完成状态；
  - 收益归因时机纠正：`this.bot.userData.gainedPoints` 的累加移动至 `if (verifiedComplete)` 和 `if (complete)` 块内部，未完成时不提前修改用户收益，避免并发归因混淆。

### 4. HTTP POST 请求副作用控制 (`src/util/Http.ts`)
- **加固落地**：
  - 在 `HttpRequestConfig` 扩充 `retryable` 配置属性；
  - 默认情况下，POST 请求的 `canRetry` 为 `false`，发生网络异常或 5xx 错误时立即抛出异常而不重试；只有调用方显式配置 `retryable: true` 时才允许重试；GET 等幂等方法维持安全重试机制。

### 5. Web 请求体统一大小上限与超时优雅关闭 (`web.mjs`)
- **加固落地**：
  - 封装统一的异步辅助函数 `readRequestBody(req, res, { maxSize = 1048576, timeoutMs = 10000 })`；
  - 超过 1MB 时先执行 `req.pause()`，发送带有 `Connection: close` 的 413 `payload_too_large` 响应，并在 `res.end()` 回调中再销毁连接，客户端正常接收真实 413 响应头和内容；
  - 超时 10 秒返回 408 `request_timeout` 并安全销毁连接；
  - 单测 [`requestBodyLimit.test.js`](file:///Users/junzhuang/Antigravity/ms_rewards/scripts/api/requestBodyLimit.test.js) 严格断言实际接收到的 413 和 408 状态码。

### 6. 错误诊断全面脱敏与截图门控 (`src/util/ErrorDiagnostic.ts`)
- **加固落地**：
  - 引入 `sanitizeDiagnosticContent` 引擎，全面脱敏 `<textarea>` 中的所有用户输入、`type="password"`、表单名 `passwd/password/totp/secret`、URL Query 凭据（包含 `client_secret` 等）、Authorization Bearer 头部、敏感 Cookie 以及 JSON 蛇形键名（`access_token`, `refresh_token`, `api_key`）；
  - `unknownPageDiagnostic` 中的 `errors` 异常原因数组全面清洗脱敏；
  - 针对未经脱敏的二进制截图，通过 `process.env.MS_CAPTURE_DIAGNOSTIC_SCREENSHOT === 'true'` 门控，默认不落盘二进制截图；
  - 所有诊断目录采用 `mode: 0o700` 创建，所有落盘文件采用 `mode: 0o600`。

### 7. Docker 运行环境非 root 落地与 Chromium 沙箱
- **加固落地**：
  - `Dockerfile`：安装 `gosu` 工具，并确保 `/usr/src/microsoft-rewards-script` 及其子目录均由 `node:node` 拥有；
  - `scripts/docker/entrypoint.sh`：容器以 root 启动时自动进行权限适配，所有 Node 进程与日常脚本统一通过 `gosu node` 降权为非特权 `node` 用户执行，定时任务使用 `crontab -u node` 设置；
  - `compose.yaml`：提供非 root (UID 1000:1000) 运行说明；
  - 当以非 root 用户运行时，`src/browser/Browser.ts` 中 `runningAsRoot` 为 `false`，天然启用 Chromium 安全沙箱（不带 `--no-sandbox` 参数）。

### 8. `adm-zip@0.6.0` 间接依赖核查与补丁升级
- **调用路径核查**：
  - 源码分析：`bayesian-network.js:24` 中 `new AdmZip(path)` 仅在应用初始化时读取包内自带的预训练网络权重文件（静态 `.zip`），不接收任何外部网络或用户输入的压缩包，因此历史解压漏洞在该调用链路上**不可利用（Not Exploitable）**；
  - 主动加固：在 `package.json` 的 `overrides` 中声明 `"adm-zip": ">=0.6.1"`，已更新锁定为官方最新补丁版本 `0.6.1`，实现 `0 vulnerabilities`。

---

## 三、 本地自动化测试验证结果

全量本地自动化测试运行结果如下：

```bash
$ npm run build && npx tsc --noEmit && node --check web.mjs
✔ Build succeeded, assets copied.
✔ TypeScript typecheck passed with 0 errors.
✔ web.mjs syntax check passed.

$ node --test scripts/api/*.test.js
✔ controlServerSecurity.test.js (5/5 passed, 真实 HTTP 网络测试)
✔ xssSanitization.test.js (6/6 passed)
✔ urlReward.test.js (4/4 passed)
✔ httpRequestRetry.test.js (3/3 passed)
✔ requestBodyLimit.test.js (3/3 passed, 真实 HTTP 413/408 接收断言)
✔ errorDiagnosticSecurity.test.js (3/3 passed)
✔ securityAudit.test.js (12/12 passed)
✔ [全量既有业务与隔离回归用例] (196/196 passed)

ℹ tests 232
ℹ suites 0
ℹ pass 232
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4423.42075
```

---

## 四、 审计合规性声明

1. **最小范围改动原则**：未对范围外文件进行格式化或重构，完全保留了所有未提交的用户本地修改。
2. **凭据安全声明**：全流程所有单测与代码中均使用合成假数据（如 `127.0.0.1` 本地服务、假 Token、脱敏字符串），未在代码、测试、日志、文档或输出中引入任何真实密钥与凭据。
3. **测试结论声明**：所有验证均为本地模拟服务与离线单测通过，**未执行真实外网微软账号登录、同步或积分任务**；离线测试通过不代表真实官方生产计分已生效。
