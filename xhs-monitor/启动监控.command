#!/bin/bash
# 双击这个文件即可启动小红书销量监控
# 关闭这个终端窗口 = 停止服务

cd "$(dirname "$0")" || exit 1

# 依赖路径：优先用环境变量，其次找本机的 node_modules，最后退回系统 node
DEPS="${XHS_DEPS_DIR:-$HOME/.workbuddy/binaries/node/workspace/node_modules}"
BROWSERS="${XHS_BROWSERS_DIR:-$HOME/.workbuddy/binaries/node/workspace/browsers}"
if [ -d "$DEPS" ]; then
  export NODE_PATH="$DEPS"
  [ -d "$BROWSERS" ] && export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS"
fi

# node 可执行文件：环境变量 > 本机受管版本 > 系统 node
if [ -n "$XHS_NODE" ]; then
  NODE_BIN="$XHS_NODE"
elif [ -x "$HOME/.workbuddy/binaries/node/versions/22.22.2-6/bin/node" ]; then
  NODE_BIN="$HOME/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "⚠️  找不到 node。请先安装 Node.js，或设置 XHS_NODE 指向 node 可执行文件。"
  read -n 1 -s -r -p "按任意键退出…"
  exit 1
fi

echo "使用 node: $NODE_BIN"

clear
echo "════════════════════════════════════════"
echo "   小红书对标销量监控"
echo "════════════════════════════════════════"
echo ""

# 已有服务在跑时，允许接管
if lsof -nP -iTCP:7788 -sTCP:LISTEN >/dev/null 2>&1; then
  OLD_PID=$(lsof -ti :7788 2>/dev/null | head -1)
  echo "检测到服务已经在运行（进程 $OLD_PID）。"
  echo ""
  echo "  [1] 直接打开页面（沿用现在这个服务）"
  echo "  [2] 停止旧服务，用本窗口重新启动"
  echo ""
  echo "如果之前是让 AI 助手帮忙启动的，建议选 [2]，"
  echo "这样服务跑在你自己的窗口里，不会随助手会话结束而中断。"
  echo ""
  read -r -p "请选择 (默认 1): " CHOICE

  if [ "$CHOICE" = "2" ]; then
    echo ""
    echo "正在停止旧服务…"
    kill "$OLD_PID" 2>/dev/null
    for i in $(seq 1 12); do
      sleep 0.5
      if ! lsof -nP -iTCP:7788 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    done
    if lsof -nP -iTCP:7788 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "⚠️  无法停止旧服务，请手动关闭后重试。"
      read -n 1 -s -r -p "按任意键退出…"
      exit 1
    fi
    echo "旧服务已停止。"
  else
    echo ""
    open "http://127.0.0.1:7788"
    echo "已打开页面，本窗口可关闭。"
    sleep 2
    exit 0
  fi
fi

echo ""
echo "正在启动，请稍候…"
echo ""

"$NODE_BIN" server.js &
SERVER_PID=$!

for i in $(seq 1 24); do
  sleep 0.5
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:7788/" 2>/dev/null; then
    break
  fi
done

if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:7788/" 2>/dev/null; then
  echo "⚠️  服务启动失败，请查看上方错误信息。"
  read -n 1 -s -r -p "按任意键退出…"
  exit 1
fi

echo ""
echo "────────────────────────────────────────"
echo "  已启动。电脑打开：  http://127.0.0.1:7788"
echo "  手机打开：见上方打印的 192.168 地址"
echo "            （需与电脑连同一个 WiFi）"
echo "────────────────────────────────────────"
echo ""
echo "⚠️  保持这个窗口开着，关掉服务就停了。"
echo ""

sleep 1
open "http://127.0.0.1:7788" 2>/dev/null

wait $SERVER_PID
