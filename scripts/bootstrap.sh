#!/usr/bin/env bash
set -euo pipefail

REPO_SSH_URL="${REPO_SSH_URL:-git@github.com:vikingleo/openclaw-network-proxy-watchdog.git}"
REPO_HTTPS_URL="${REPO_HTTPS_URL:-https://github.com/vikingleo/openclaw-network-proxy-watchdog.git}"
DEFAULT_INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.cache/openclaw-extensions}"
PLUGIN_DIR_NAME="network-proxy-watchdog"

usage() {
  cat <<'USAGE'
OpenClaw Network Proxy Watchdog 远程 bootstrap

用法：
  curl -fsSL <bootstrap-url> | bash -s -- --openclaw-dir /path/to/openclaw [install-options]

行为：
  - 检测 git / node / npm
  - 自动 clone 或 update 本仓库到本地缓存目录
  - 调用 scripts/install.sh 完成真正安装

常用参数：
  --openclaw-dir <path>       OpenClaw 宿主目录（必填）
  --repo-dir <path>           本地缓存目录，默认 ~/.cache/openclaw-extensions/network-proxy-watchdog
  --ref <git-ref>             指定分支/标签/提交，默认当前远端 HEAD
  --https                     显式使用 HTTPS clone（默认）
  --ssh                       强制使用 SSH clone
  --help                      显示帮助

其余参数会原样传给 scripts/install.sh。
USAGE
}

OPENCLAW_DIR=""
REPO_DIR="${DEFAULT_INSTALL_ROOT}/${PLUGIN_DIR_NAME}"
GIT_REF=""
USE_HTTPS=1
PASSTHRU_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --openclaw-dir)
      OPENCLAW_DIR="${2:-}"
      shift 2
      ;;
    --repo-dir)
      REPO_DIR="${2:-}"
      shift 2
      ;;
    --ref)
      GIT_REF="${2:-}"
      shift 2
      ;;
    --https)
      USE_HTTPS=1
      shift
      ;;
    --ssh)
      USE_HTTPS=0
      shift
      ;;
    *)
      PASSTHRU_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$OPENCLAW_DIR" ]]; then
  echo "缺少必填参数：--openclaw-dir <path>" >&2
  usage
  exit 1
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少依赖命令：$1" >&2
    exit 1
  fi
}

need_cmd git
need_cmd node
need_cmd npm

mkdir -p "$(dirname "$REPO_DIR")"

REPO_TO_USE="$REPO_HTTPS_URL"
if [[ "$USE_HTTPS" != "1" ]]; then
  REPO_TO_USE="$REPO_SSH_URL"
fi

if [[ -d "$REPO_DIR/.git" ]]; then
  echo "发现已有仓库，正在更新：$REPO_DIR"
  git -C "$REPO_DIR" fetch --tags --prune origin
else
  echo "正在克隆仓库到：$REPO_DIR"
  git clone "$REPO_TO_USE" "$REPO_DIR"
fi

if [[ -n "$GIT_REF" ]]; then
  git -C "$REPO_DIR" checkout "$GIT_REF"
else
  current_branch="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD || true)"
  if [[ -n "$current_branch" ]]; then
    git -C "$REPO_DIR" pull --ff-only origin "$current_branch"
  fi
fi

INSTALL_SCRIPT="$REPO_DIR/scripts/install.sh"
if [[ ! -x "$INSTALL_SCRIPT" ]]; then
  chmod +x "$INSTALL_SCRIPT"
fi

exec "$INSTALL_SCRIPT" --openclaw-dir "$OPENCLAW_DIR" "${PASSTHRU_ARGS[@]}"
