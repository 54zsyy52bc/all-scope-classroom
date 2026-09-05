#!/usr/bin/env bash
# =============================================================================
# 课堂管理系统 · 一键测试脚本
#
# 用法:
#   ./run-tests.sh            # 快速模式：两端单元/无头测试 + 质量门禁（无需 broker）
#   ./run-tests.sh --full     # 完整模式：快速模式 + 真实 SIoT broker 全链路冒烟
#
# 覆盖:
#   教师端  selfcheck / routes / preset-pkg / dashboard.dom
#   Preset Studio  store（本地库）/ renderer.dom
#   学生端  protocol / renderer.dom
#   门禁    单文件 <= 300 行 / P0 emoji 扫描
#   [--full] smoke(真实 broker 全链路 77 项) + net.broker(学生端真机联调)
#
# 退出码: 0 = 全部通过, 1 = 存在失败
# =============================================================================
set -u

MODE="${1:-fast}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
TEACHER="$ROOT/teacher"
STUDENT="$ROOT/student"
STUDIO="$ROOT/preset-studio"
SIOT_DIR="$(dirname "$ROOT")/SIoT_V2_Win_2618/SIoT_V2_Win_2618"
SIOT_EXE="$SIOT_DIR/main.exe"
LOG=/tmp/run-tests-last.log

# ---- 颜色（Git Bash 终端支持 ANSI）----
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'

# ---- Node 检测：优先用托管 Node 22（版本锁定），回退 PATH ----
NODE=""
if [ -x "$HOME/.workbuddy/binaries/node/versions/22.22.2/node.exe" ]; then
  NODE="$HOME/.workbuddy/binaries/node/versions/22.22.2/node.exe"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "${RED}[错误]${RESET} 未找到 Node.js，请安装或配置 PATH" >&2
  exit 1
fi

PASS=0; FAILED=0; FAILED_NAMES=()
note() { echo "${DIM}-- $*${RESET}"; }
ok()   { PASS=$((PASS + 1)); echo "  ${GREEN}[PASS]${RESET} $1"; }
bad()  { FAILED=$((FAILED + 1)); FAILED_NAMES+=("$1"); echo "  ${RED}[FAIL]${RESET} $1"; }
tail_log() { tail -12 "$LOG" | sed 's/^/        /'; }
run_case() { # run_case <名称> <目录> <命令...>
  local name="$1" dir="$2"; shift 2
  note "$name"
  if ( cd "$dir" && "$@" ) >"$LOG" 2>&1; then ok "$name"; else bad "$name"; tail_log; fi
}

echo "================================================================"
echo " 课堂管理系统 · 一键测试   mode=${YELLOW}${MODE}${RESET}"
echo " Node: $("$NODE" -v)   Root: $ROOT"
echo "================================================================"

# ---------------------------------------------------------------------------
# 1. 教师端单元/无头测试
# ---------------------------------------------------------------------------
echo
echo "${YELLOW}== 教师端 ==${RESET}"

run_case "教师端自检 selfcheck"        "$TEACHER" env DB_PATH=/tmp/rt-selfcheck-$$.db "$NODE" test/selfcheck.js
run_case "路由完整性 routes"           "$TEACHER" "$NODE" test/routes.js
run_case "预设包协议 preset-pkg"       "$TEACHER" "$NODE" test/preset-pkg.test.js
run_case "大屏渲染 dashboard.dom"      "$TEACHER" "$NODE" test/dashboard.dom.test.js

# ---------------------------------------------------------------------------
# 1b. Preset Studio 独立应用（v4：办公端预设编辑器）
# ---------------------------------------------------------------------------
echo
echo "${YELLOW}== Preset Studio ==${RESET}"

run_case "本地库 store"           "$STUDIO" "$NODE" test/store.test.js
run_case "渲染层 renderer.dom"    "$STUDIO" "$NODE" test/renderer.dom.test.js

# ---------------------------------------------------------------------------
# 2. 学生端单元/无头测试
# ---------------------------------------------------------------------------
echo
echo "${YELLOW}== 学生端 ==${RESET}"

run_case "协议结构 protocol"        "$STUDENT" "$NODE" test/protocol.test.js
run_case "渲染层流程 renderer.dom"  "$STUDENT" "$NODE" test/renderer.dom.test.js

# ---------------------------------------------------------------------------
# 3. 质量门禁：常规文件 <= 300 行；db 仓储/存储后端允许 <= 320（函数仓库）
# ---------------------------------------------------------------------------
echo
echo "${YELLOW}== 质量门禁 ==${RESET}"
over=0
for base in \
  "$TEACHER/server.js" \
  "$TEACHER/src/"*.js "$TEACHER/src/"*/*.js \
  "$TEACHER/public/"*.js \
  "$STUDENT/main.js" "$STUDENT/preload.js" "$STUDENT/renderer/"*.js \
  "$STUDIO/src/"*.js "$STUDIO/renderer/"*.js \
  "$STUDIO/electron/"*.js "$STUDIO/preload.js"; do
  [ -f "$base" ] || continue
  n=$(wc -l < "$base")
  limit=300; case "$base" in *"/db/"*) limit=320;; esac
  if [ "$n" -gt "$limit" ]; then echo "  ${RED}[超线] $n 行(上限$limit)  ${base#$ROOT/}${RESET}"; over=1; fi
done
if [ "$over" -eq 0 ]; then ok "行数门禁（常规 300 / db 320）"; else bad "行数门禁"; fi

# ---------------------------------------------------------------------------
# 4. 质量门禁：P0 emoji 扫描（UI 代码不得出现 emoji 作图标）
# ---------------------------------------------------------------------------
EMOJI_RE='[\x{1F300}-\x{1F9FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}]'
if grep -rPn "$EMOJI_RE" "$TEACHER/public" "$STUDENT/renderer" "$STUDIO/renderer" "$TEACHER/src/routes" >"$LOG" 2>&1; then
  bad "P0 emoji 扫描"; head -5 "$LOG" | sed 's/^/        /'
else
  ok "P0 emoji 扫描（UI 代码干净）"
fi

# ---------------------------------------------------------------------------
# 5. 完整模式：真实 SIoT broker 全链路冒烟
# ---------------------------------------------------------------------------
if [ "$MODE" = "--full" ] || [ "$MODE" = "full" ]; then
  echo
  echo "${YELLOW}== 完整冒烟（真实 SIoT broker）==${RESET}"

  if [ ! -f "$SIOT_EXE" ]; then
    bad "broker 启动（找不到 $SIOT_EXE）"
  else
    # 5.1 清理 1883 端口残留 -> 启动 broker
    for p in $(netstat -ano 2>/dev/null | grep ':1883' | grep -i listening | awk '{print $5}' | sort -u); do
      taskkill /F /PID "$p" >/dev/null 2>&1 || true
    done
    ( cd "$SIOT_DIR" && nohup ./main.exe -c conf/config.json >/tmp/siot-e2e.log 2>&1 & echo $! >/tmp/siot-e2e.pid )
    SIOT_PID=$(cat /tmp/siot-e2e.pid 2>/dev/null || echo "")
    note "SIoT broker 启动中 (pid=${SIOT_PID:-?}) ..."

    # 5.2 等待 broker 就绪（最多 20s）
    ready=0
    for i in $(seq 1 20); do
      if netstat -ano 2>/dev/null | grep ':1883' | grep -qi listening; then ready=1; break; fi
      sleep 1
    done
    if [ "$ready" -eq 0 ]; then
      bad "broker 监听 1883"; tail -8 /tmp/siot-e2e.log | sed 's/^/        /'
    else
      ok "broker 就绪（1883）"

      # 5.3 启动 teacher server（临时库）
      rm -f /tmp/rt-e2e-$$.db*
      ( cd "$TEACHER" && DB_PATH=/tmp/rt-e2e-$$.db nohup "$NODE" server.js >/tmp/teacher-e2e.log 2>&1 & echo $! >/tmp/teacher-e2e.pid )
      SRV_PID=$(cat /tmp/teacher-e2e.pid 2>/dev/null || echo "")
      note "teacher server 启动中 (pid=${SRV_PID:-?}) ..."

      srv_ready=0
      for i in $(seq 1 15); do
        # 注意: curl 是 Windows 版, -o /dev/null 会写失败, 用 bash 重定向丢弃输出
        if curl -s --max-time 2 "http://127.0.0.1:3000/api/v1/dashboard/snapshot" >/dev/null 2>&1; then srv_ready=1; break; fi
        sleep 1
      done
      if [ "$srv_ready" -eq 0 ]; then
        bad "teacher server 就绪（http://127.0.0.1:3000）"; tail -8 /tmp/teacher-e2e.log | sed 's/^/        /'
      else
        ok "teacher server 就绪（3000）"
        # 5.4 全链路冒烟（真实 broker）
        run_case "全链路冒烟 smoke（真实 broker）" "$TEACHER" env DB_PATH=/tmp/rt-e2e-$$.db "$NODE" test/smoke.js
        # 5.5 学生端真机联调（需 broker 仍在跑）
        run_case "学生端真机联调 net.broker"      "$STUDENT" env SIOT_IP=127.0.0.1 SIOT_WS_PORT=1888 "$NODE" test/net.broker.test.js
      fi

      # 5.6 清理 server（按端口反查，确保杀到 node 本体）
      for p in $(netstat -ano 2>/dev/null | grep ':3000' | grep -i listening | awk '{print $5}' | sort -u); do
        taskkill /F /PID "$p" >/dev/null 2>&1 || true
      done
      rm -f /tmp/rt-e2e-$$.db*
    fi

    # 5.7 清理 broker
    for p in $(netstat -ano 2>/dev/null | grep ':1883' | grep -i listening | awk '{print $5}' | sort -u); do
      taskkill /F /PID "$p" >/dev/null 2>&1 || true
    done
    rm -f /tmp/siot-e2e.pid /tmp/teacher-e2e.pid
    note "进程已清理（端口 3000 / 1883）"
  fi
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
echo
echo "================================================================"
if [ "$FAILED" -eq 0 ]; then
  echo "  ${GREEN}全部通过：${PASS} 项 ✓${RESET}"
  echo "================================================================"
  exit 0
else
  echo "  ${RED}通过 ${PASS} 项，失败 ${FAILED} 项：${FAILED_NAMES[*]}${RESET}"
  echo "================================================================"
  exit 1
fi
