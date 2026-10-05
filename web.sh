#!/bin/bash
# ==============================================================================
# Microsoft Rewards Fluent Web 控制台启动脚本 (B/S 架构)
# 支持 macOS 原生三重防休眠守护 (caffeinate -i -s -m) 与默认浏览器自动唤醒
# ==============================================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT=3888

# 1. 启动前安全清理旧残留的孤儿 Node/Chrome 进程
pkill -f "node web.mjs" 2>/dev/null || true

echo "🚀 正在启动 Microsoft Rewards Fluent Web 控制台..."
echo "🛡️ macOS 三重防休眠守护已激活 (允许快捷键锁屏与屏幕熄灭)"

# 2. 异步打开浏览器
(sleep 1.2 && open "http://localhost:${PORT}") &

# 3. 运行 Web 服务并附带系统防休眠
exec caffeinate -i -s -m node web.mjs
