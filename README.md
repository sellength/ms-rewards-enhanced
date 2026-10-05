# Microsoft Rewards Script Enhanced (ms-rewards-enhanced)

[![GitHub License](https://img.shields.io/badge/License-GPL%20v3-blue.svg?style=for-the-badge)](./LICENSE)
[![Release](https://img.shields.io/badge/Release-v0.1.0-brightgreen?style=for-the-badge)](https://github.com/sellength/ms-rewards-enhanced/releases)
[![Docker](https://img.shields.io/badge/Docker-GHCR-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/sellength/ms-rewards-enhanced/pkgs/container/ms-rewards-enhanced)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

> [!NOTE]
> **开源致谢与上游声明 (Credits & Acknowledgements)**  
> 本项目（**ms-rewards-enhanced**）基于杰出的开源项目 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) 进行深度二次开发与架构增强。  
> 衷心感谢原作者 **@TheNetsky** 以及所有上游贡献者在 Microsoft Rewards 自动化领域奠定的坚实基础！  
> 本项目遵循 **GNU General Public License v3.0 (GPL-3.0)** 协议，完整继承开源许可并对社区开放全部增强源码。

---

## 📖 目录 (Table of Contents)

- [✨ 增强特性 (What's New in Enhanced Edition)](#-增强特性-whats-new-in-enhanced-edition)
- [🐳 快速开始：Docker 容器部署 (推荐)](#-快速开始docker-容器部署-推荐)
    - [1. 准备环境配置文件 (.env)](#1-准备环境配置文件-env)
    - [2. 方式 A: Docker Compose 一键启动 (最推荐)](#2-方式-a-docker-compose-一键启动-最推荐)
    - [3. 方式 B: Docker CLI 单行命令运行](#3-方式-b-docker-cli-单行命令运行)
- [💻 源码本地运行 (Bare Metal / Node.js)](#-源码本地运行-bare-metal--nodejs)
- [🔒 首次连接与 Web 控制台安全配对](#-首次连接与-web-控制台安全配对)
- [⚙️ 配置选项手册 (Configuration Reference)](#️-配置选项手册-configuration-reference)
    - [核心配置 (Core)](#核心配置-core)
    - [任务开关 (Workers)](#任务开关-workers)
    - [搜索设置 (Search Settings)](#搜索设置-search-settings)
- [📜 开源许可证与免责声明 (License & Disclaimer)](#-开源许可证与免责声明-license--disclaimer)

---

## ✨ 增强特性 (What's New in Enhanced Edition)

相比上游原版，**ms-rewards-enhanced** 针对微软近期的 Rewards UI 改版、反作弊风控升级以及多端环境隔离进行了系统级优化重构：

* 🌟 **Fluent Web 现代化可视化控制台**：
  * 内置响应式 Web 仪表盘（默认监听 `http://127.0.0.1:3888`），直观展示 PC 桌面端与移动端今日积分、任务子卡片完成度及实时执行日志流；
  * 提供带外一次配对安全凭证（`sessions/.web_pairing_secret`）、DNS 重绑定防护、CSRF 独立令牌与反代 IP 白名单。
* 🧠 **自适应拟人化动力学引擎 (Adaptive Agent)**：
  * **阅读与思考延时**：作答前自动注入 2500ms ~ 4500ms 拟人化阅读延时，杜绝机械秒答特征；
  * **平滑贝塞尔鼠标轨迹**：以人类生物学加速度曲线移动鼠标，点击按钮在 30%~70% 范围内产生正态随机偏移与微抖动；
  * **语义与题型自适应感知**：自适应识别单选、多选、投票与顺序题型，规避 BotScore 标记风险。
* 🔍 **Explore on Bing (必应探索) 新协议打通**：
  * 完整支持微软最新推出的 Explore on Bing 模块，自动通过协议加密提交 `submitAppActivity` 唤醒待激活卡片，并执行真实交互意图搜索。
* ⏱️ **Edge 浏览 30 分钟真值闭环**：
  * 引入 `getEdgeWebProgress()` 实时校验，以官方 Rewards Web 端真实进度为唯一真值，彻底消除虚假完成或提前退出隐患。
* 🛡️ **PC 与移动端环境严格隔离**：
  * PC 桌面搜索与移动端搜索配额独立跟踪、会话指纹严格物理隔离，杜绝交叉污染。
* 📦 **开箱即用多架构 Docker 镜像**：
  * 原生支持 `linux/amd64` 与 `linux/arm64`（兼容 x86 服务器、NAS、Mac Apple Silicon、树莓派及各类云主机）。

---

## 🐳 快速开始：Docker 容器部署 (推荐)

项目预构建 Docker 镜像托管于 GitHub Container Registry (GHCR)：`ghcr.io/sellength/ms-rewards-enhanced:0.1.0`。

### 1. 准备环境配置文件 (`.env`)

在您的项目工作目录中创建 `.env` 文件，填入您的微软账号凭据：

```env
# 账号 1
ACCOUNT_1_EMAIL=your_email@outlook.com
# ACCOUNT_1_PASSWORD=your_password (若使用无密码登录/Authenticator验证可不填)
# ACCOUNT_1_TOTP_SECRET=JBSWY3DPEHPK3PXP (可选：2FA 两步验证密钥)

# 代理配置 (可选：美区或海外账号建议配置稳定代理)
# ACCOUNT_1_PROXY_URL=http://user:pass@proxy-server:port
```

---

### 2. 方式 A: Docker Compose 一键启动 (最推荐)

在当前目录下创建 `compose.yaml` 文件：

```yaml
services:
  ms-rewards:
    image: ghcr.io/sellength/ms-rewards-enhanced:0.1.0
    container_name: ms-rewards-enhanced
    restart: unless-stopped
    ports:
      - '3888:3888'                 # Fluent Web 控制台访问端口
    volumes:
      - ./config:/usr/src/microsoft-rewards-script/config
      - ./sessions:/usr/src/microsoft-rewards-script/sessions
    env_file:
      - .env
    environment:
      TZ: 'Asia/Shanghai'           # 容器时区
      WEB_MODE: 'true'              # 启用 Fluent Web 控制台模式
      HOST: '0.0.0.0'               # 允许局域网访问
      ALLOWED_HOSTS: 'localhost,127.0.0.1,192.168.*' # 允许的主机头(防 DNS 重绑定)
      # RUN_ON_START: 'true'        # 启动时是否立即运行一次任务
      # CRON_SCHEDULE: '0 8 * * *'  # 每日定时执行计划(例如每天早上 08:00)
    security_opt:
      - no-new-privileges:true
```

启动容器：
```bash
docker compose up -d
```

查看运行日志：
```bash
docker compose logs -f
```

---

### 3. 方式 B: Docker CLI 单行命令运行

```bash
docker run -d \
  --name ms-rewards-enhanced \
  -p 3888:3888 \
  -v $(pwd)/config:/usr/src/microsoft-rewards-script/config \
  -v $(pwd)/sessions:/usr/src/microsoft-rewards-script/sessions \
  --env-file .env \
  -e TZ=Asia/Shanghai \
  -e WEB_MODE=true \
  --restart unless-stopped \
  ghcr.io/sellength/ms-rewards-enhanced:0.1.0
```

---

## 💻 源码本地运行 (Bare Metal / Node.js)

如果您希望在宿主机（macOS / Linux / Windows）直接从源码运行：

### 1. 环境依赖
* **Node.js** >= 24.0.0
* **npm** 或 **pnpm**
* **Git**

### 2. 安装与构建
```bash
# 1. 克隆代码库并切换到 dev 分支
git clone -b dev https://github.com/sellength/ms-rewards-enhanced.git
cd ms-rewards-enhanced

# 2. 安装依赖并自动安装带防检测补丁的 Chromium
npm install
npx patchright install chromium

# 3. 编译 TypeScript 代码
npm run build
```

### 3. 启动运行
```bash
# 启动 Fluent Web 交互控制台 (默认访问 http://127.0.0.1:3888)
npm run web

# 或在 macOS 下使用带系统防休眠保护的启动脚本
./web.sh

# 传统 CLI 一次性命令行执行模式
npm start
```

---

## 🔒 首次连接与 Web 控制台安全配对

为保护账号与会话安全，Web 控制台默认开启**带外设备配对保护**：

1. **查看配对凭据**：
   * 首次启动后，服务端会自动生成高强度安全配对码，并保存在本地 `sessions/.web_pairing_secret` 文件中：
     ```bash
     cat sessions/.web_pairing_secret
     ```
2. **浏览器授权配对**：
   * 在浏览器中打开 `http://localhost:3888`（或您的服务器局域网 IP:3888）；
   * 在弹出的配对窗口中粘贴上述配对码并提交。
3. **一次配对，持久免密**：
   * 配对成功后，服务端会向当前浏览器颁发高熵安全凭证（`HttpOnly; SameSite=Strict` Cookie）。
   * 日常访问无需重复输入配对码（支持 90 天自动滑动续期）；如需解绑，可在控制台设置中点击“撤销所有设备”。

---

## ⚙️ 配置选项手册 (Configuration Reference)

可通过修改 `config/config.json` 或在 Docker 中设置环境变量进行自定义。

### 核心配置 (Core)

| 参数名称 | 类型 | 默认值 | 说明 | Docker 环境变量 |
| :--- | :--- | :--- | :--- | :--- |
| `sessionPath` | string | `"sessions"` | 会话持久化存储目录 | — |
| `headless` | boolean | `false` | 是否使用无头模式运行（Docker 中强制为 true） | — |
| `clusters` | number | `1` | 并发账号集群数量 | `CONFIG_CLUSTERS` |
| `skipNonPointTasks` | boolean | `true` | 自动跳过 0 积分任务 | `CONFIG_SKIP_NON_POINT_TASKS` |
| `accountDelay.min` | string | `"1min"` | 账号间执行的最小间隔时间 | `CONFIG_ACCOUNT_DELAY_MIN` |
| `accountDelay.max` | string | `"3min"` | 账号间执行的最大间隔时间 | `CONFIG_ACCOUNT_DELAY_MAX` |
| `globalTimeout` | string | `"30sec"` | 单项操作超时时间 | `CONFIG_GLOBAL_TIMEOUT` |

### 任务开关 (Workers)

| 参数名称 | 类型 | 默认值 | 说明 | Docker 环境变量 |
| :--- | :--- | :--- | :--- | :--- |
| `workers.doDailySet` | boolean | `true` | 每日问答、投票集锦打卡 | `CONFIG_WORKER_DAILY_SET` |
| `workers.doMorePromotions` | boolean | `true` | 更多活动与推广卡片 | `CONFIG_WORKER_MORE_PROMOTIONS` |
| `workers.doPunchCards` | boolean | `true` | 专题活动打卡 (Punch Cards) | `CONFIG_WORKER_PUNCH_CARDS` |
| `workers.doDesktopSearch` | boolean | `true` | PC 桌面端必应搜索 | `CONFIG_WORKER_DESKTOP_SEARCH` |
| `workers.doMobileSearch` | boolean | `true` | 移动端 App 必应搜索 | `CONFIG_WORKER_MOBILE_SEARCH` |
| `workers.doDailyCheckIn` | boolean | `true` | 移动端每日签到 (Check-in) | `CONFIG_WORKER_DAILY_CHECKIN` |
| `workers.doReadToEarn` | boolean | `true` | 移动端阅读资讯赚积分 | `CONFIG_WORKER_READ_TO_EARN` |

### 搜索设置 (Search Settings)

| 参数名称 | 类型 | 默认值 | 说明 | Docker 环境变量 |
| :--- | :--- | :--- | :--- | :--- |
| `searchSettings.parallelSearching` | boolean | `true` | PC 与移动端并行搜索 | `CONFIG_SEARCH_PARALLEL` |
| `searchSettings.clusterSearch` | boolean | `true` | 基于必应智能联想词聚类搜索 | `CONFIG_SEARCH_CLUSTER` |
| `searchSettings.searchDelay.min` | string | `"15sec"` | 单次搜索最小随机间隔 | `CONFIG_SEARCH_DELAY_MIN` |
| `searchSettings.searchDelay.max` | string | `"35sec"` | 单次搜索最大随机间隔 | `CONFIG_SEARCH_DELAY_MAX` |

---

## 📜 开源许可证与免责声明 (License & Disclaimer)

### 免责声明 (Disclaimer)
1. 本项目仅供学习、研究和自动化测试之用，请勿用于非法用途或违反服务条款的商业行为。
2. 使用自动化工具可能存在被服务提供商限制或封控账号的风险，使用者需自行承担相应责任。
3. 项目作者与贡献者不对使用本程序造成的任何账户异常、积分变动或损失负责。

### 许可证 (License)
本项目继承原项目协议，遵循 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 协议发布。  
Derivative work based on [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) under GNU GPL v3.
