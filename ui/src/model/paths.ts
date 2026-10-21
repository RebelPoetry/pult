// Пути файлов в реплике: ⌘V на файле из Finder и перетаскивание кладут в поле путь, как в нативных
// приложениях. Чистые функции — их проверяет ui/test без окна.

/** Путь с пробелом или кавычкой — в одинарных кавычках (как в оболочке), чтобы модель не разрезала его. */
export function quotePath(p: string): string {
  return /[\s'"\\$`]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p
}

/** Вставить пути на место выделения; пробел до и после — только если вплотную стоит текст. */
export function insertPaths(text: string, start: number, end: number, paths: readonly string[]): { text: string; caret: number } {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const head = before + lead + paths.map(quotePath).join(' ') + trail
  return { text: head + after, caret: head.length }
}

/** Как окно узнаёт пути: из буфера (все скопированные файлы) и из перетащенных `File`. */
export interface FilePathSource {
  clipboard(): Promise<string[]>
  files(files: File[]): string[]
}
