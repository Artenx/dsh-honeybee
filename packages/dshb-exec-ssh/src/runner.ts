export interface RunnerPayload {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

function encodeLine(value: string): string {
  return Buffer.from(`${value}\n`, 'utf8').toString('base64')
}

export function encodeRunnerPayload(payload: RunnerPayload): Buffer {
  const lines: string[] = []
  lines.push(encodeLine(payload.cwd))
  lines.push(encodeLine(String(payload.argv.length)))
  for (const arg of payload.argv) lines.push(encodeLine(arg))
  const envEntries = Object.entries(payload.env)
  lines.push(encodeLine(String(envEntries.length)))
  for (const [k, v] of envEntries) lines.push(encodeLine(`${k}=${v}`))
  lines.push('.')
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

export const REMOTE_RUNNER_SCRIPT = `set -u
if ! command -v base64 >/dev/null 2>&1; then echo "runner: base64 not found" >&2; exit 127; fi
dec() {
  printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D 2>/dev/null
}
readline_crlf() {
  IFS= read -r line
  line=\${line%$'\\r'}
}
readline_crlf
cwd=$(dec "$line")
readline_crlf
argc=$(dec "$line")
argv=()
i=0
while [ "$i" -lt "$argc" ]; do
  readline_crlf
  argv+=("$(dec "$line")")
  i=$((i + 1))
done
readline_crlf
envc=$(dec "$line")
env_vars=()
i=0
while [ "$i" -lt "$envc" ]; do
  readline_crlf
  kv=$(dec "$line")
  k=\${kv%%=*}
  v=\${kv#*=}
  env_vars+=("$k=$v")
  i=$((i + 1))
done
readline_crlf
[ "$line" = "." ] || { echo "runner: protocol error" >&2; exit 126; }
cd "$cwd" 2>/dev/null || { echo "runner: cwd not found: $cwd" >&2; exit 126; }
exec env -i HOME="\$HOME" PATH="\${PATH:-/usr/local/bin:/usr/bin:/bin}" \${env_vars[@]+"\${env_vars[@]}"} "\${argv[@]}"
`.trim()

export const REMOTE_RUNNER_COMMAND = `sh -c ${JSON.stringify(REMOTE_RUNNER_SCRIPT)}`

export function isRunnerSafe(command: string): boolean {
  return command === REMOTE_RUNNER_COMMAND || command.includes(REMOTE_RUNNER_SCRIPT)
}
