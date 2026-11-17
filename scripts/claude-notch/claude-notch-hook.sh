#!/bin/sh
# Claude Code hook: forwards the event to claude-notch-daemon.mjs, starting it if needed.
input=$(cat)
socket="$HOME/.claude/atoll-notch/hook.sock"
send() {
  # 590 s stays under the 600 s PermissionRequest hook timeout, so curl gives up first.
  printf '%s' "$input" | curl -sf --max-time 590 --unix-socket "$socket" \
    --data-binary @- "http://localhost/hook?ppid=$PPID"
}
send
# 7 = could not connect. Any other failure (Atoll busy, timeout) is not worth a retry.
[ $? -eq 7 ] || exit 0
nohup "${1:-node}" "$(dirname "$0")/claude-notch-daemon.mjs" >/dev/null 2>&1 &
sleep 0.5
send
exit 0
