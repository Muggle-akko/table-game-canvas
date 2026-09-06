#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"
DEMO_PAGE="$PROJECT_DIR/public/index.html"
DEMO_URL="file://${DEMO_PAGE// /%20}"

if [[ ! -f "$DEMO_PAGE" ]]; then
  echo "找不到 Demo 页面：$DEMO_PAGE"
  echo "请确认项目文件完整后再试。"
  read -r "?按回车关闭…"
  exit 1
fi

echo "正在打开 Parlor 离线试玩入口…"
echo "选择资源包后即可进入；不会启动 Node 或公网隧道。"
open "$DEMO_URL"
