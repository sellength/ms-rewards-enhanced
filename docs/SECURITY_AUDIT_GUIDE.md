# 🛡️ Microsoft Rewards 自动化工作台安全审计与架构合规指南 (Security Audit Guide)

> **审计基线版本**: `v4.3.1-patch1.7.0`  
> **适用对象**: 信息安全审计师、合规审查员、系统架构师  
> **文档定位**: 阐述本系统的安全隔离边界、凭据保护、会话生命周期、防风控跳过策略与数据合规设计。

---

## 一、 核心安全架构与隔离边界

### 1.1 双端物理隔离 (Terminal Isolation)
* **PC 端**：通过 Patchright 无头 Chromium 运行，模拟真实桌面浏览器行为，仅加载 Web 专属任务，严格保持 Web 态 User-Agent 与 Headers。
* **移动端**：基于官方 Bing App 原生 REST 网关（`channel=SAAndroid` 与动态 RSC 流）通信，绝不跨端共享浏览器 Page 或 Context。
* **Cookie 与会话隔离**：
  * 系统内置 Cookie 清洗器（`src/util/SessionSanitizer.ts` / `scripts/api/sessionSanitizer.mjs`）；
  * PC 端请求自动剥离移动专有的脏追踪 Cookie（如 `_SS`, `_RwBf`, `_Rwho`, `PC=SANSAAND`），杜绝因 Cookie 交叉污染引发微软云端跨端风控；
  * 移动端与 PC 端在本地各自独立存储会话，彼此无共享变量。

### 1.2 网络接口与本地绑定安全
* **仅绑定本地回环**：Web 控制台默认仅监听 `127.0.0.1` / `localhost`，不开放公网暴露端口；
* **环境隔离**：支持 HTTP/SOCKS5 代理挂载，网络请求均经由指定安全通道流转，确保出口 IP 与账号归属区域（Region）完全对齐。

---

## 二、 凭据加密与敏感数据保护

### 2.1 凭据静态加密存储 (Credential Protection)
* **加密算法**：基于 `AES-256-GCM` 认证加密算法（`src/util/ProfileCrypto.ts`）；
* **密钥派生**：使用基于设备硬件环境与静态盐派生的对称密钥，密码与敏感 Token 在 SQLite 数据库（`sessions/sessions.db`）中以 `enc:v1:<iv>:<ciphertext>` 密文格式持久化；
* **内存脱敏**：前端界面下发账号列表时，API Key、密码等核心敏感字段均经过脱敏遮罩处理（如 `sk-***abcd`），禁止明文在网络传输或渲染。

### 2.2 绝对零数据外泄原则 (Zero Data Leakage)
* **官方接口直连**：AI 意图引擎（如 OpenAI、Google Gemini、DeepSeek 等）请求直接发送至其官方 OpenAPI 端点，不经过任何未经鉴权的第三方中转服务；
* **传输内容最小化**：调用 AI 模型时，传输的 Prompt 仅包含任务的主题词（如“根据金融理财生成一条搜索疑问句”），**绝不携带任何账号信息、Cookies、User-Agent、Token 或地理位置信息**；
* **日志安全门禁**：系统各 Logger 模块（`Logger.ts`）严格遵守数据脱敏规范，日志中只保留任务标识（OfferId）与状态码，绝对禁止将账户密码、Cookie 串或 Session 写入本地日志文件或打包产物中。

---

## 三、 会话注销与生命周期清理 (Session Lifecycle)

根据项目 `REQ-SESSION-LOGOUT-001` 契约规范，系统提供不可逆的安全注销链路（`scripts/api/sessionLogout.mjs`）：
1. **持久化清除**：彻底删除该账号在 SQLite 中的 `desktop` 与 `mobile` 会话记录、指纹缓存与元数据；
2. **临时缓存清理**：同步清理 `daily_state.json` 与 `mobile_state.json` 中的缓存；
3. **运行时现场复位**：重置内存中的 `runtimeReplay` 运行快照与探测缓存，防止旧账号活动数据残留在新会话中；
4. **幂等防护**：重复调用注销具有幂等安全性，正在执行任务时禁止注销，避免产生脏状态。

---

## 四、 自动化风控规避与 6 大安全跳过策略 (Skip Policies)

为确保执行过程不触发微软云端防御系统（Bot Detection / Rate Limit），执行器部署了严格的安全策略矩阵：

| 策略标识 | 触发条件 | 安全执行动作 | 安全与审计理由 |
| :--- | :--- | :--- | :--- |
| **`skip_tomorrow_locked`** | 卡片被标记为“明天激活 / 明日解锁”或 `status: locked` | **直接跳过**，不产生网络请求 | 微软时间锁未到，提前强刷 0 分且极易被审计为恶意嗅探。 |
| **`skip_complete`** | 任务已达满分（如 10/10）或搜索配额归零 | **直接跳过**，零重复请求 | 防止过度发包触发微软防刷限流机制。 |
| **`skip_cooldown_reached`** | 连续 2 次意图搜索 0 分，或拿满当日 40 分上限 | **自动熔断**，终止后续同类卡片 | 检测到云端 15 分钟限频冷却或每日封顶，及时停手保护账号。 |
| **`skip_manual_required`** | 需要特定移动 App 硬件环境或复杂交互 | **跳过并提示人工** | 严禁使用通用协议伪造硬件指纹，降低账号封禁风险。 |
| **`skip_non_point_tasks`** | 分值为 0 的商业宣传/赞助广告卡 | **安全忽略** | 避免加载未经授权的第三方重定向链接。 |
| **`skip_safety_guard`** | 页面出现人机验证（Challenge）或安全告警 | **最高优先级熔断**，退出运行 | 遇到风控探针立即退出，保护账号不被二次标记。 |

---

## 五、 审计人员自动化验证方法

项目附带完整的单元与集成回归测试套件，审计人员可在本地沙箱中无网络依赖一键验证：

```bash
# 1. 运行所有 API、状态机与安全隔离测试（共 198 项）
node --test scripts/api/*.test.js

# 2. 检查特定安全隔离机制
node --test scripts/api/sessionSanitizer.test.js  # 验证 Dirty Cookie 清洗与跨端隔离
node --test scripts/api/sessionLogout.test.js     # 验证安全注销与数据清除
node --test scripts/api/taskIsolation.test.js     # 验证任务故障隔离与单点熔断
node --test scripts/api/taskStatus.test.js        # 验证 6 大跳过策略与次日锁定判定

# 3. TypeScript 静态类型与语法检查
npx tsc --noEmit
node --check web.mjs
```

---

## 六、 核心源码安全索引表

| 审计方向 | 核心源代码文件 | 审计要点 |
| :--- | :--- | :--- |
| **凭据加密** | `src/util/ProfileCrypto.ts` | AES-256-GCM 算法、IV 生成与加解密逻辑 |
| **会话脱敏** | `src/util/SessionSanitizer.ts`<br>`scripts/api/sessionSanitizer.mjs` | 跨端 Cookie 过滤、敏感字段剥离 |
| **状态机与跳过** | `promotion-classification.cjs`<br>`src/functions/activities/app/AppPromotions.ts`<br>`src/functions/activities/rewards/MorePromotions.ts` | 次日锁定判定、连续0分熔断、人工任务标记 |
| **安全注销** | `scripts/api/sessionLogout.mjs` | SQLite 数据库抹除、缓存销毁 |
| **任务隔离** | `src/util/TaskIsolation.ts` | 异常捕获、任务隔离、失败不穿透 |
