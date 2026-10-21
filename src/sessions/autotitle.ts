// Автоназвание сессии (07.10.2026): по первой реплике сессия без названия получает короткое имя
// для списков — как в нативных Claude Code и Codex. Дешёвый одноразовый запрос к haiku со своим
// коротким системным промптом, без инструментов, настроек и записи сессии (замер: ~600 входных
// токенов, ~$0.003, ~7 с — в фоне, реплику не задерживает). Страж сети не пустил, CLI нет, ответ
// не годится — название из первых слов задачи: сессия без имени хуже, чем неидеальное имя.

import { SESSION_TITLE_MAX } from './registry.js'
import type { ExecResult } from '../env/exec.js'

export const TITLE_SYSTEM_PROMPT =
  'Ты придумываешь короткие названия рабочим сессиям по первой задаче. Ответь ТОЛЬКО названием: 2–5 слов, на языке задачи, без кавычек и точки в конце.'

/** Сколько текста задачи уходит в запрос: на название хватает начала. */
const PROMPT_CHARS = 2000

/** Название из первых слов задачи: первая содержательная строка, до 6 слов. */
export function fallbackTitle(text: string): string | null {
  const line = text.split('\n').map((l) => l.replace(/^[#>*\-\s`]+/, '').trim()).find((l) => l.length > 0) ?? ''
  const words = line.split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
  const cut = [...words].slice(0, SESSION_TITLE_MAX).join('').replace(/[\s.,:;!?…—-]+$/u, '')
  return cut || null
}

/** Ответ модели → название: первая строка, без кавычек и точки, не длиннее предела списка. */
export function cleanModelTitle(raw: string): string | null {
  const first = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  // Кавычки и точка вперемешку («…».): снимаем по кругу, пока края не перестанут меняться.
  let t = first
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/^["'«»“”„`\s]+|["'«»“”„`\s]+$/gu, '').replace(/[.。]+$/u, '') }
  if (!t || [...t].length > SESSION_TITLE_MAX || t.split(/\s+/).length > 8) return null
  return t
}

export interface AutoTitlerOptions {
  bin: string
  cwd: string
  /** Окружение запроса через страж сети; `null` — страж не пускает, сразу первые слова. */
  env(): Promise<Record<string, string> | null>
  run(bin: string, args: string[], opts: { env: Record<string, string>; cwd: string; timeoutMs: number }): Promise<ExecResult>
  onError?(e: string): void
}

export function claudeTitleArgs(text: string): string[] {
  return [
    '-p', '--model', 'haiku', '--effort', 'low',
    '--system-prompt', TITLE_SYSTEM_PROMPT,
    '--tools', '', '--setting-sources', '', '--no-session-persistence',
    '--output-format', 'json',
    `Задача: ${text.slice(0, PROMPT_CHARS)}`,
  ]
}

export function createAutoTitler(opts: AutoTitlerOptions): (text: string) => Promise<string | null> {
  return async (text) => {
    try {
      const env = await opts.env()
      if (env) {
        const r = await opts.run(opts.bin, claudeTitleArgs(text), { env, cwd: opts.cwd, timeoutMs: 45_000 })
        if (r.status === 0) {
          const o = JSON.parse(r.stdout) as { result?: unknown; is_error?: unknown }
          const t = o.is_error !== true && typeof o.result === 'string' ? cleanModelTitle(o.result) : null
          if (t) return t
        } else {
          opts.onError?.(`claude -p: код ${r.status ?? '—'} ${r.error ?? r.stderr.slice(0, 200)}`)
        }
      }
    } catch (e) {
      opts.onError?.((e as Error).message)
    }
    return fallbackTitle(text)
  }
}
