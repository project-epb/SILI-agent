#!/bin/bash
# 本地预览用户信息框模板：
#   ./dev.sh 后浏览器打开 http://127.0.0.1:6781/index.html?data=<JSON>
# data 为 UserInfoboxPayload 的 JSON（URL-encoded）。
cd "$(dirname "$0")"
bunx live-server --port=6781
