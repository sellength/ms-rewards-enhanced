# 🛠️ Microsoft Rewards Script 部署与运行全指南

> [!IMPORTANT]
> **当前实际运行架构：源码直接运行模式 (Source Mode, bare metal / macOS / Linux / Windows)**  
> 本应用当前**直接从源码运行在宿主机上**（通过 Node.js 执行 `node web.mjs` / `./web.sh` 或 `npm start`）。
>
> **未来部署架构：Docker 容器化部署（通过 GitHub Actions 构建并发布至 Docker Hub）**  
> Docker 是规划中的未来部署方案，将通过 GitHub Actions 自动化构建后发布至 Docker Hub。  
> ⚠️ **镜像重要警示**：当前文档与 `compose.yaml` 中出现的 `ghcr.io/thenetsky/microsoft-rewards-script:4` 为上游原始示例镜像，**并不是当前部署**！上游原版镜像未包含本项目的任何定制修复与补丁（缺失 Fluent Web 控制台、一次配对无感免密设备凭证、CSRF 独立解耦、损坏凭证降级锁屏、反代 IP 白名单等）。未来使用 Docker 部署的用户，**必须使用由本项目修复补丁构建的镜像**（通过 `build: .` 本地构建，或从即将发布的 Docker Hub 专属镜像拉取），切勿直接拉取上游未修复镜像运行 Web 模式。

本项目支持以下运行方式：

| 模式 | 运行环境 | 适用场景 | 核心特点 |
| :--- | :--- | :--- | :--- |
| **方式 1：源码直接运行（当前生产）** | **宿主机本地 (macOS / Linux / Windows)** | 本地电脑、开发环境、个人日常常驻 | 极简直启、原生流畅、无容器网络层损耗、支持 macOS 原生防休眠守护 |
| **方式 2：Docker 容器化（未来发布）** | **Docker / Docker Compose** | OpenWrt 路由器、软路由、群晖/威联通/Unraid NAS、无桌面服务器 | 依赖环境自包含、定时无头打卡、支持构建至 Docker Hub |

---

## 💻 方式 1：源码直接运行指南（当前实际部署方式）

### 1. 运行依赖
- Node.js >= 24（推荐使用 LTS 版本）
- npm >= 10

### 2. 初始化与构建
在项目根目录下执行安装与编译：
```bash
# 安装项目依赖
npm install

# 编译 TypeScript 源码及资源
npm run build
```

### 3. 配置账号凭据 (`.env`)
在项目根目录下创建 `.env` 文件（可参考 `env.example`）：
```env
ACCOUNT_1_EMAIL=your_email@outlook.com
# ACCOUNT_1_PASSWORD=your_password (若使用微软验证器 Authenticator，请留空)
# ACCOUNT_1_TOTP_SECRET=JBSWY3DPEHPK3PXP (可选 2FA 密钥)
```

### 4. 启动 Fluent Web 控制台
```bash
# 启动 Web 控制台 (默认监听 127.0.0.1:3888)
npm run web

# 或者在 macOS 上使用附带三重防休眠守护的启动脚本：
./web.sh
```

### 5. 首次浏览器配对与日常无感访问
1. **查看配对码**：
   在终端查看自动生成的高熵配对码文件（无需人工配置密码）：
   ```bash
   cat sessions/.web_pairing_secret
   ```
   （Windows 用户可在文件资源管理器开启“显示隐藏文件”后打开 `sessions/.web_pairing_secret` 查看）
2. **浏览器配对**：
   打开浏览器访问 `http://localhost:3888`，在配对弹窗中输入配对码并提交。
3. **日常无感访问**：
   配对成功后，该浏览器将获得专属的独立长期 HttpOnly 设备 Cookie；日常关闭浏览器、服务重启均**完全免密直接进入**，并在日常活跃使用中享受 90 天自动滑动续期！

---

## 🐳 方式 2：Docker 容器化部署指南（未来发布至 Docker Hub）

> [!WARNING]
> **切勿直接拉取上游未修复镜像运行 Web 控制台！**  
> 当前上游 `ghcr.io/thenetsky/microsoft-rewards-script:4` 镜像未包含 Fluent Web 控制台与本轮安全修复。未来使用 Docker 部署时，请在 `compose.yaml` 中启用 `build: .` 本地构建，或拉取未来正式发布至 Docker Hub 的专属修复镜像。

---

## 🛠️ 第一步：通用准备工作

在运行任何模式之前，先完成以下基础准备：

### 1. 创建本地工作目录
```bash
mkdir -p ~/ms_rewards && cd ~/ms_rewards
mkdir -p config sessions
```

### 2. 准备账号凭据文件 `.env`
在工作目录下创建 `.env` 文件，填入您的微软 Rewards 账号信息：

```bash
cat << 'EOF' > .env
# 第 1 个账号（必填）
ACCOUNT_1_EMAIL=your_email@outlook.com
# 如果使用密码登录请填入（若使用无密码/微软验证器 Authenticator，请保持注释留空）
# ACCOUNT_1_PASSWORD=your_password

# 如果开启了二次验证 (2FA)，填入 TOTP 密钥自动生成 6 位验证码（可选）
# ACCOUNT_1_TOTP_SECRET=JBSWY3DPEHPK3PXP

# 区域与语言设置（可选，建议留空自动识别）
ACCOUNT_1_LANG_CODE=zh-Hans
ACCOUNT_1_GEO_LOCALE=auto
EOF
```

> [!NOTE]
> 支持多账号配置：可继续添加 `ACCOUNT_2_EMAIL`、`ACCOUNT_3_EMAIL` 等，脚本将按序依次执行。

---

## 🚀 模式 1：无头自动化定时调度模式（推荐 OpenWrt / NAS）

这是专为路由器、NAS 和服务器设计的经典模式。容器内置轻量级调度器，根据 CRON 表达式每天定时自动启动内部无头浏览器执行打卡、搜索和每日三项，任务完成后自动休眠。

### 方法 A：使用 Docker Compose（推荐）

> ⚠️ **构建与镜像标签特别说明**：  
> 上游原版镜像 `ghcr.io/thenetsky/microsoft-rewards-script:4` 未包含本项目的各项修复与补丁。  
> 若未来使用 Docker 部署，**必须同时配置 `build:` 上下文与独立的本地镜像标签**（如 `image: microsoft-rewards-script:local`），绝不能只解开 `build` 却保留上游镜像标签；并使用 `docker compose up -d --build` 显式构建启动：

在工作目录下创建 `compose.yaml`：

```yaml
services:
  microsoft-rewards-script:
    build:
      context: .
    image: microsoft-rewards-script:local  # 独立本地镜像标签（切勿保留上游 GHCR 标签）
    container_name: microsoft-rewards-script
    restart: unless-stopped
    volumes:
      - ./config:/usr/src/microsoft-rewards-script/config
      - ./sessions:/usr/src/microsoft-rewards-script/sessions
    env_file:
      - .env
    environment:
      # 时区设置（与您当地时间一致）
      TZ: 'Asia/Shanghai'
      # 定时执行表达式（例如每天早上 7:30 自动执行，使用 crontab.guru 换算）
      CRON_SCHEDULE: '30 7 * * *'
      # 容器启动时是否立即执行一次
      RUN_ON_START: 'true'
      # 每次账号执行之间是否跳过随机延迟（家庭路由器建议设为 false 保持真实行为）
      SKIP_RANDOM_SLEEP: 'false'
    security_opt:
      - no-new-privileges:true
```

启动命令（带 `--build` 确保使用最新补丁构建）：
```bash
docker compose up -d --build
```

### 方法 B：使用 `docker run` 单行命令运行

```bash
# 1. 先构建本地专属镜像：
docker build -t microsoft-rewards-script:local .

# 2. 运行容器：
docker run -d \
  --name microsoft-rewards-script \
  --restart unless-stopped \
  -v $(pwd)/config:/usr/src/microsoft-rewards-script/config \
  -v $(pwd)/sessions:/usr/src/microsoft-rewards-script/sessions \
  --env-file .env \
  -e TZ="Asia/Shanghai" \
  -e CRON_SCHEDULE="30 7 * * *" \
  -e RUN_ON_START="true" \
  microsoft-rewards-script:local
```

### 查看运行状态与日志：
```bash
docker logs -f microsoft-rewards-script
```

> [!TIP]
> **特点**：无端口暴露、零 Web 交互、完全不需要配对码。如果是在 OpenWrt 上部署，该模式最为稳定省电。

---

## 💻 模式 2：Fluent Web 可视化控制台模式（局域网/远程面板）

如果您希望在局域网电脑、平板或手机浏览器中直接打开图形化管理面板，监控 PC 与移动端任务进度、查看实时控制台日志、配置专属 AI 或一键手动执行，可开启此模式。

### 核心环境变量解析（针对 Docker 局域网访问）

当部署在 Docker 容器或 OpenWrt 时，由于涉及跨容器/跨局域网访问，需要配置以下 3 个环境变量：

1. **`WEB_MODE=true`**：告诉容器入口直接启动 Fluent Web 控制台；
2. **`HOST=0.0.0.0`**：让服务监听所有网络接口（默认为 127.0.0.1 仅容器内回环），允许宿主机和局域网外部设备访问；
3. **`ALLOWED_HOSTS`**：**Host 头访问白名单（安全防护）**。必须填入您访问该服务时使用的路由器 IP、NAS IP 或域名（如 `192.168.1.1,localhost`），防止 DNS Rebinding 攻击；
4. **`MS_WEB_PAIRING_SECRET`**：**自定义配对密钥**。设置一个您自己的固定访问密码（必须 >= 15 字符且非弱口令，如 `MySecretPassword2026`）。首次在浏览器打开时直接输入此密码配对即可，无需进入容器内部翻找随机密钥文件。

### Docker Compose 配置示例

> ⚠️ **构建与镜像标签特别说明**：  
> Fluent Web 控制台为定制功能，上游原版镜像未包含此功能。未来使用 Docker 部署时，**必须同时配置 `build:` 上下文与独立的本地镜像标签**（如 `image: microsoft-rewards-web:local`），绝不能保留上游 GHCR 镜像标签，并使用 `docker compose up -d --build` 显式构建启动：

在工作目录下创建或修改 `compose.yaml`：

```yaml
services:
  microsoft-rewards-web:
    build:
      context: .
    image: microsoft-rewards-web:local  # 独立本地镜像标签（切勿保留上游 GHCR 标签）
    container_name: microsoft-rewards-web
    restart: unless-stopped
    ports:
      - '3888:3888'  # 映射 Web 控制台端口
    volumes:
      - ./config:/usr/src/microsoft-rewards-script/config
      - ./sessions:/usr/src/microsoft-rewards-script/sessions
    env_file:
      - .env
    environment:
      TZ: 'Asia/Shanghai'
      # ── 开启 Web 控制台 ──
      WEB_MODE: 'true'
      HOST: '0.0.0.0'
      # 替换为您的 OpenWrt / NAS 宿主机实际局域网 IP (支持自定义端口映射如 4888:3888)
      ALLOWED_HOSTS: '192.168.1.1,localhost,127.0.0.1'
      # 可选：自定义配对密码（>= 15 字符）；若留空，程序会自动在宿主机 sessions/.web_pairing_secret 生成高熵码
      # MS_WEB_PAIRING_SECRET: 'YourStrongCustomPassword2026'
      # TRUSTED_PROXIES: '127.0.0.1,172.17.0.1' # 若位于可信反向代理 (Nginx/Caddy) 后，配置反代 IP 白名单以安全解析客户端真实 IP 和 HTTPS
    security_opt:
      - no-new-privileges:true
```

启动命令（带 `--build` 确保使用最新补丁构建）：
```bash
docker compose up -d --build
```

### 首次连接配对流程与局域网访问：
1. **查看配对凭据**：
   - **默认方式（自动生成高熵码，推荐）：** 无需配置 `MS_WEB_PAIRING_SECRET`。容器启动后，直接在宿主机的 `compose.yaml` 同级目录下查看 `sessions/.web_pairing_secret` 隐藏文件（在 Linux/macOS 宿主机终端执行 `cat sessions/.web_pairing_secret`，或在 Windows 开启“显示隐藏文件”后用记事本打开，**无需进入容器或执行 `docker exec`**）。若文件为空或格式异常，服务会进入安全降级锁屏状态（HTTP 500 明确报错，输入框与提交按钮禁用，未授权配对绝对不开放，不发放内存伪码），并完整保留宿主机原文件供管理员排查修复，绝不静默覆盖。
   - **自定义密码：** 若在环境变量中设置了 `MS_WEB_PAIRING_SECRET`（必须 >= 15 字符，自动拦截弱密码），则使用您自定义的密码；此时环境变量优先生效，程序不会生成文件。
2. **浏览器访问与首次配对**：
   - 在同一局域网的电脑或手机浏览器打开：`http://<您的宿主机或路由器IP>:3888`（若在 compose 中自定义了宿主机端口如 `4888:3888`，则访问 `http://<IP>:4888`）；
   - 首次访问弹出 **“控制台设备安全配对”** 页面；在输入框中输入上述配对码并提交；
   - 系统内置防暴力破解保护（连续 5 次失败自动锁定 60 秒并返回 429；默认使用真实底层 socket IP，杜绝伪造 `X-Forwarded-For` 绕过；成功配对立即解除锁定）；
3. **日常访问完全无感**：
   - 配对成功后，服务端为该浏览器颁发专属的高熵独立长期设备凭据（存入 `HttpOnly; SameSite=Strict` Cookie），并与服务端 `auth_epoch` 绑定；
   - **绑定仅需一次**：日常关闭/重新打开浏览器、Docker 容器重启或镜像更新重建，均**免密直接进入**，活跃访问自动享受 90 天滑动续期；
   - 若需让所有已授权浏览器重新配对，管理员可在控制台设置中点击“⚡ 撤销所有设备授权”；修改 `MS_WEB_PAIRING_SECRET` 仅影响后续新设备的首次配对。
4. **安全与网络防护说明**：
   - **局域网访问严格鉴权**：系统绝不因请求来自私网/局域网 IP 就推断受信任而免除配对认证，局域网访问同样必须强制首次配对；
   - **反代与限速说明**：反代环境下建议配置 `TRUSTED_PROXIES` 白名单（如 `127.0.0.1,172.17.0.1`），使限速计数准确区分真实客户端 IP 并识别 HTTPS；在非安全局域网或有远程暴露需求时强烈建议启用 HTTPS。

---

## 🔒 数据持久化与会话安全须知

容器中的 `./sessions` 挂载目录极为关键：
1. **微软登录凭据持久化**：首次登录成功后，微软的 Session 缓存与加密后的指纹将保存在 `./sessions` 中。后续运行直接复用，**无需每次重新登录**；
2. **Web 配对凭据持久化**：如果未设置 `MS_WEB_PAIRING_SECRET`，程序会自动在宿主机 `sessions/.web_pairing_secret` 生成高熵随机密钥。挂载数据卷可确保容器重启后凭据不会丢失；
3. **严格权限与完整性保护**：程序以非特权 `node` 用户运行，所有保存的敏感会话均经过操作系统权限（`0600`）隔离保护。程序 fail closed，若 sessions 目录无法读写或配对凭据文件损坏将显式报错并阻断，绝不发放未持久化的内存伪码，绝不覆盖已有异常凭据文件。

---

## ❓ 常见问题排查 (FAQ)

### Q1：在 OpenWrt 路由器上部署，应该选择哪种模式？
- **绝大多数用户推荐选择「模式 1：无头自动化定时调度模式」**：设置每天定时执行一次，不需要占用 Web 端口与内存常驻，不影响路由器正常的网络转发性能；
- **如果确实需要手机/局域网管理界面，才选择「模式 2：Web 控制台模式」**，并注意设置 `ALLOWED_HOSTS` 包含路由器的 LAN 口 IP（如 `192.168.1.1`）。

### Q2：打开 Web 控制台提示 `403 Forbidden: 非法 Host 请求头`？
- 这是因为安全审计要求启用了防 DNS 重绑定拦截；
- 检查 `compose.yaml` 中的 `ALLOWED_HOSTS`，确保包含了您在浏览器地址栏输入的那个 IP 或域名（多个以英文逗号分隔，例如 `ALLOWED_HOSTS: "192.168.1.1,192.168.1.100,myserver.lan"`）。

### Q3：如何更新到最新的 Docker 镜像版本？
```bash
docker compose pull
docker compose up -d
```
数据均保存在本地 `./config` 与 `./sessions`，更新镜像不会丢失您的账号会话和配置。

### Q4：在 Docker 容器中能否点击“微软官方窗口登录”？
- **不能**。“微软官方窗口登录”功能（`scripts/main/interactiveLogin.mjs`）使用图形化（headful）浏览器直接弹出登录窗口，需要桌面显示系统（如 macOS 或 Windows 桌面）。
- 无桌面环境的 Docker 容器中缺少 X11 / Wayland 图形服务，触发该动作将无法弹出窗口。
- **容器化登录推荐方式**：
  1. 在 `.env` 中直接配置 `ACCOUNT_1_EMAIL` 与 `ACCOUNT_1_PASSWORD`，程序启动时将在容器内通过无头浏览器自动完成登录；
  2. 或在宿主机使用源码模式运行 `./web.sh`，完成官方窗口登录生成 `sessions/sessions.db` 会话后，直接挂载给 Docker 容器复用。
