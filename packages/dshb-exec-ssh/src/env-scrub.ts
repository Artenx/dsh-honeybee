const DANGEROUS_PREFIXES = ['DSH', 'MCAI', 'OPENAI', 'ANTHROPIC', 'DEEPSEEK', 'LLM', 'API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL']

export function shouldScrubVar(name: string): boolean {
  const upper = name.toUpperCase()
  return DANGEROUS_PREFIXES.some((p) => upper === p || upper.startsWith(`${p}_`))
}

export function scrubEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!shouldScrubVar(key)) result[key] = value
  }
  return result
}

export const RUNNER_ENV_HINTS = [
  'DSH_*',
  'MCAI_*',
  'OPENAI*',
  'ANTHROPIC*',
  'DEEPSEEK*',
  'LLM_*',
  'API_KEY*',
  'TOKEN*',
  'SECRET*',
  'PASSWORD*',
  'CREDENTIAL*',
]
