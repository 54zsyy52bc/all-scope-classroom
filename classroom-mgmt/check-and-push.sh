#!/usr/bin/env bash
# =============================================================================
# 先审后推：全量审查（run-tests.sh --full）全绿才允许 commit + push
# 用法：bash check-and-push.sh "提交说明"
# 说明：较大代码更新后必须走这条路径（见 全域md文档/02-开发与设计文档/09_审查总纲.md）
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")"

MSG="${1:-chore: 常规更新（已通过全量审查）}"
ROOT="$(pwd)"

echo "== 1/3 全量审查 =="
bash run-tests.sh --full
RC=$?
if [ "$RC" -ne 0 ]; then
  echo ""
  echo "审查未通过（退出码 $RC）：禁止提交与推送。请修复后重试。"
  exit 1
fi

echo ""
echo "== 2/3 提交 =="
git add -A
if git diff --cached --quiet; then
  echo "无待提交改动，跳过 commit。"
else
  git commit -m "$MSG" || { echo "提交失败"; exit 1; }
fi

echo ""
echo "== 3/3 推送 =="
GIT_TERMINAL_PROMPT=0 git push origin main --tags 2>/tmp/gitpush.err
PRC=$?
if [ "$PRC" -ne 0 ]; then
  if grep -qi "could not read Username\|terminal prompts\|could not read Password" /tmp/gitpush.err; then
    echo "沙箱无 GCM 凭证，请在桌面终端执行："
    echo "  cd ${ROOT} && git push origin main --tags"
    exit 2
  fi
  echo "推送失败："
  tail -5 /tmp/gitpush.err
  exit 1
fi
echo "推送完成 ✓"
