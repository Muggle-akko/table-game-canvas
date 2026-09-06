#!/bin/zsh

set -u

project_dir="${0:A:h}"
cd "$project_dir" || exit 1

printf '\nParlor 共享牌桌\n'
printf '项目目录：%s\n\n' "$project_dir"

read "host_name?房主显示名（直接回车使用「房主A」）："
host_name="${host_name:-房主A}"

printf '\n选择这次铺上桌的资源包：\n'
printf '  1) 标准扑克 · 54 张（默认）\n'
printf '  2) UNO · 108 张\n'
printf '  3) 月面哨站 · 示例资源包\n'
printf '  4) 自定义 JSON 路径\n\n'
read "pack_choice?输入编号后回车："

case "${pack_choice:-1}" in
  1) pack_path="./game-packs/standard-54.json" ;;
  2) pack_path="./game-packs/uno.json" ;;
  3) pack_path="./game-packs/moon-outpost.json" ;;
  4)
    read "pack_path?输入游戏包 JSON 路径："
    if [[ -z "$pack_path" ]]; then
      printf '\n没有填写游戏包路径，尚未启动房间。\n'
      read "?按回车关闭窗口…"
      exit 1
    fi
    ;;
  *)
    printf '\n无法识别这个编号，尚未启动房间。\n'
    read "?按回车关闭窗口…"
    exit 1
    ;;
esac

if ! npm run validate:pack -- "$pack_path"; then
  printf '\n游戏包没有通过校验，尚未启动房间。\n'
  read "?按回车关闭窗口…"
  exit 1
fi

room_arguments=(--name "$host_name" --pack "$pack_path")

if [[ ! -x "$project_dir/.tools/cloudflared" ]]; then
  printf '\n第一次开房需要准备公网隧道工具。\n'
  if ! npm run setup:tunnel; then
    printf '\n隧道工具准备失败。上方保留了具体错误。\n'
    read "?按回车关闭窗口…"
    exit 1
  fi
fi

printf '\n正在铺桌。只有健康检查通过后才会显示邀请链接。\n'
printf '保持这个窗口打开；关闭窗口就会结束房间。\n\n'

npm run room -- "${room_arguments[@]}"
exit_code=$?

if (( exit_code != 0 )); then
  printf '\n开房没有成功。上方保留了具体错误。\n'
  read "?按回车关闭窗口…"
fi

exit "$exit_code"
