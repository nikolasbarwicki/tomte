# The commands a bot's Bash runs under scripts/probe-credential-fd.ts: every route by which a bot's shell could read a
# credential the host handed to the Claude CLI (its environment, inherited descriptors, /proc/<pid>/fd and
# /proc/<pid>/environ of itself, every ancestor and every visible process). The probe's canary is
# `canary-<32 hex digits>`; this script recognises it by that shape, so the canary never appears in the command, and it
# never prints one: every line it prints passes through `redact`. A route that holds the canary prints `CANARY-IN <route>`.
#
# The TypeScript side passes this file as one `bash -c` argument, so it must not read its own stdin.

redact() { sed -E 's/canary-[0-9a-f]{32}/<CANARY>/g'; }
section() { printf '=== %s ===\n' "$1"; }
# scan ROUTE: reads stdin and says whether the canary is in it.
scan() { if grep -a -q -E 'canary-[0-9a-f]{32}'; then echo "CANARY-IN $1"; fi; }

dump_pid() {
  p=$1
  [ -d /proc/$p ] || return 0
  printf -- '--- pid %s: %s\n' "$p" "$(tr '\0' ' ' </proc/$p/cmdline 2>&1 | head -c 100 | redact)"
  grep -E '^(PPid|Uid|NSpid):' /proc/$p/status 2>&1 | tr '\t' ' '
  for f in /proc/$p/fd/*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    n=${f##*/}
    printf '  fd %s -> %s\n' "$n" "$(readlink "$f" 2>&1 | redact)"
    case $n in 0 | 1 | 2) continue ;; esac
    # Reopening the descriptor through /proc: a file gives its bytes again, a pipe or socket gives an error or nothing.
    d=$(timeout 2 head -c 64 "$f" </dev/null 2>&1 | tr -c '[:print:]' '.')
    printf '    reopen: %s\n' "$(printf %s "$d" | redact)"
    printf %s "$d" | scan "pid $p fd $n (reopened through /proc)"
  done
  if [ -r /proc/$p/environ ]; then
    printf '  environ names: %s\n' "$(tr '\0' '\n' </proc/$p/environ | cut -d= -f1 | sort | tr '\n' ' ')"
    for name in $(tr '\0' '\n' </proc/$p/environ | grep -a -E 'canary-[0-9a-f]{32}' | cut -d= -f1); do
      echo "CANARY-IN pid $p environ variable $name"
    done
  else
    echo "  environ: not readable"
  fi
  # Anything else of the process that holds bytes: its command line and the memory-mapped names are not credentials,
  # but a canary passed as an argument would be.
  tr '\0' '\n' </proc/$p/cmdline 2>/dev/null | scan "pid $p command line"
}

section "environment variables of this shell (names; values of TOKEN, KEY and SECRET names hidden)"
env | grep -E 'ANTHROPIC|CLAUDE|TOKEN' | awk -F= '{
  name = $1; value = substr($0, length($1) + 2)
  if (name ~ /(TOKEN|KEY|SECRET|PASSWORD)$/) value = "<" length(value) " chars>"
  print name "=" value
}' | redact
env | scan "this shell's environment"

section "ls -l /proc/self/fd"
ls -l /proc/self/fd 2>&1 | redact

section "this shell: its own descriptors, read directly and through /proc"
for f in /proc/$$/fd/*; do
  n=${f##*/}
  case $n in 0 | 1 | 2) continue ;; esac
  [ -e "$f" ] || [ -L "$f" ] || continue
  d=$({ timeout 2 head -c 64 <&"$n"; } 2>&1 | tr -c '[:print:]' '.')
  printf '  fd %s -> %s; read directly: %s\n' "$n" "$(readlink "$f" 2>&1 | redact)" "$(printf %s "$d" | redact)"
  printf %s "$d" | scan "this shell's inherited fd $n (read directly)"
done
dump_pid $$

section "ancestors, from the parent up (/proc/<pid>/status PPid chain)"
dumped=" $$ "
pid=$(awk '/^PPid:/ {print $2}' /proc/$$/status)
chain=""
while [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null; do
  chain="$chain $pid"
  if [ ! -d /proc/$pid ]; then
    echo "--- pid $pid: no /proc entry (not visible from here)"
    break
  fi
  dump_pid "$pid"
  dumped="$dumped$pid "
  pid=$(awk '/^PPid:/ {print $2}' /proc/$pid/status 2>/dev/null)
done
echo "chain:$chain"

section "ls /proc (which pids are visible at all)"
visible=$(ls /proc | grep -E '^[0-9]+$' | tr '\n' ' ')
echo "visible pids: $visible"
echo "visible pid count: $(echo $visible | wc -w)"

section "every other visible process"
me=$(id -u)
for pid in $visible; do
  case "$dumped" in *" $pid "*) continue ;; esac
  # Another user's process is not this shell's to read; the sandbox hides them, an unsandboxed shell would only be refused.
  [ "$(awk '/^Uid:/ {print $2}' /proc/$pid/status 2>/dev/null)" = "$me" ] || continue
  dump_pid "$pid"
done

section "end"
echo "probe finished"
