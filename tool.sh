# Run this to see what Claude Code is doing during startup
strace -e trace=open,openat,stat -o /tmp/claude-trace.log claude 2>&1 &
sleep 5
killall claude
grep -E '(open|stat).*".*"' /tmp/claude-trace.log | tail -50
