# Шрифты окна Пульта: источник и лицензии

Окно не ходит в сеть (CSP `font-src 'self'`, `connect-src 'none'`), поэтому шрифты лежат в пакете —
в `dist/ui/fonts/`. Файлы woff2 в репозиторий не кладутся: `scripts/build-ui.mjs` копирует их при
каждой сборке из devDependencies корня и кладёт рядом полный текст лицензии (`<шрифт>-OFL.txt`).

| Шрифт | Где в окне | Пакет (devDependency) | Правообладатель | Лицензия |
|---|---|---|---|---|
| Geologica | заголовки | `@fontsource-variable/geologica` | The Geologica Project Authors, github.com/googlefonts/geologica | SIL OFL 1.1 |
| Onest | текст | `@fontsource-variable/onest` | The Onest Project Authors, github.com/simpals/onest | SIL OFL 1.1 |
| JetBrains Mono | код, идентификаторы, счётчики | `@fontsource-variable/jetbrains-mono` | The JetBrains Mono Project Authors, github.com/JetBrains/JetBrainsMono | SIL OFL 1.1 |

- **Источник:** пакеты fontsource (github.com/fontsource/font-files) — это те же файлы Google Fonts
  (fonts.gstatic.com), разложенные по подмножествам; ставятся из npm по `package-lock.json` с проверкой целостности.
- **Что берём:** вариативные файлы оси `wght` (одна гарнитура на все веса), подмножества `cyrillic`,
  `cyrillic-ext`, `latin`, `latin-ext` — 12 файлов, около 230 КБ.
- **Имена гарнитур** в `@font-face` — `Geologica`, `Onest`, `JetBrains Mono` (как у страницы v0.6),
  без суффикса `Variable` из пакетов. OFL разрешает это: Reserved Font Name у этих шрифтов не объявлено.
- **Условия OFL**, которые мы выполняем: шрифты не продаются отдельно, текст лицензии идёт вместе с файлами.
- **Совместимость с MIT** (лицензия кода Пульта, `LICENSE` в корне): OFL разрешает вшивать шрифты в программу под
  любой лицензией и распространять вместе с ней — сами шрифты при этом остаются под OFL, отдельно не продаются и
  идут со своим текстом лицензии.
