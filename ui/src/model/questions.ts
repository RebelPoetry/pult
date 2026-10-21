// Вопросы модели человеку — в Inbox карточкой с вариантами, а не «разрешить/отказать». Две формы:
//   Claude `AskUserQuestion` — {questions: [{question, header, options: [{label, description}], multiSelect}]};
//     ключ ответа — ТЕКСТ вопроса (так его ждёт CLI в `updatedInput.answers`), «свой ответ» есть всегда;
//   Codex `requestUserInput` — {questions: [{id, header, question, options|null, isOther, isSecret}]}; ключ — id.
// Здесь обе приводятся к одной форме; ответ уходит демону как {ключ: {answers: [...]}}.

export interface QuestionView {
  key: string
  header: string
  question: string
  options: ReadonlyArray<{ label: string; description: string }>
  /** Можно выбрать несколько вариантов. */
  multi: boolean
  /** Поле «свой ответ». */
  other: boolean
  secret: boolean
}

export const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'requestUserInput'])
export const isQuestionTool = (toolName: string | undefined): boolean => QUESTION_TOOLS.has(toolName ?? '')

const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {})
const text = (x: unknown): string => (typeof x === 'string' ? x : '')
const optionsOf = (x: unknown): Array<{ label: string; description: string }> =>
  Array.isArray(x) ? x.flatMap((o) => { const r = rec(o); return text(r['label']) ? [{ label: text(r['label']), description: text(r['description']) }] : [] }) : []

export function questionsOf(toolName: string, input: Record<string, unknown>): QuestionView[] {
  const list = Array.isArray(input['questions']) ? input['questions'] : []
  return list.flatMap((raw): QuestionView[] => {
    const q = rec(raw)
    if (toolName === 'AskUserQuestion') {
      const question = text(q['question'])
      if (!question) return []
      return [{ key: question, header: text(q['header']), question, options: optionsOf(q['options']), multi: q['multiSelect'] === true, other: true, secret: false }]
    }
    const id = text(q['id'])
    if (!id) return []
    const options = optionsOf(q['options'])
    return [{ key: id, header: text(q['header']), question: text(q['question']), options, multi: true, other: !options.length || q['isOther'] === true, secret: q['isSecret'] === true }]
  })
}

/**
 * Ответы по выбранному и «своему ответу». Одиночный выбор: свой ответ, если он есть, иначе выбранный
 * вариант. Множественный: выбранные варианты плюс свой ответ.
 */
export function buildAnswers(questions: readonly QuestionView[], chosen: Readonly<Record<string, readonly string[]>>, other: Readonly<Record<string, string>>): Record<string, { answers: string[] }> {
  return Object.fromEntries(questions.map((q) => {
    const own = other[q.key]?.trim()
    const picked = [...(chosen[q.key] ?? [])]
    const answers = q.multi ? [...picked, ...(own ? [own] : [])] : own ? [own] : picked.slice(0, 1)
    return [q.key, { answers }]
  }))
}

export const answersReady = (answers: Record<string, { answers: string[] }>, questions: readonly QuestionView[]): boolean =>
  questions.length > 0 && questions.every((q) => (answers[q.key]?.answers.length ?? 0) > 0)
