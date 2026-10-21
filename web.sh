#!/bin/bash
# ==============================================================================
# Microsoft Rewards Fluent Web 控制台启动脚本 (B/S 架构)
# 支持跨平台任务运行期动态防休眠守护 (允许熄屏与锁屏，任务完成后自动释放恢复休眠)
# ==============================================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT=3888

# 1. 启动前安全清理旧残留的孤儿 Node/Chrome 进程
pkill -f "node web.mjs" 2>/dev/null || true

echo "🚀 正在启动 Microsoft Rewards Fluent Web 控制台..."
echo "🛡️ 任务运行期动态防休眠已就绪 (仅在任务运行时阻止系统睡眠，允许熄屏锁屏，完成后自动释放)"

# 2. 异步打开浏览器
(sleep 1.2 && open "http://localhost:${PORT}") &

# 3. 运行 Web 服务 (由 web.mjs 在任务执行期按需申请并在结束时释放系统防休眠锁)
exec node web.mjs
