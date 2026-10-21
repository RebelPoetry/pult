# FACTS — проверенные факты для страницы (дополняют SPEC.md, при конфликте FACTS важнее)

## Claude Code (проверено по code.claude.com/docs, 18.09.2026)

### Правила подписки (источник: code.claude.com/docs/en/legal-and-compliance — цитаты сверены лидом дословно)
- РАЗРЕШЕНО: «Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own
  Claude subscription, including where a platform hosts Claude Code…»
- ЗАПРЕЩЕНО: «Anthropic does not permit third-party developers to offer Claude.ai login into their own applications,
  or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may
  not collect, store, or intermediate Claude.ai credentials or session tokens…»
- Для продукта, который запускает Claude Code у пользователей: бинарь не модифицировать, способы входа не отключать,
  использование не перепродавать и не оплачивать за пользователя; требуется согласие с Commercial Terms of Service.
- Про Agent SDK в продуктах: «Developers building products… including those using the Agent SDK, should use API key
  authentication». Личное использование SDK на своей подписке покрыто фразой «ordinary, individual usage of Claude
  Code and the Agent SDK».
- Нельзя использовать имя и логотип Claude Code / Anthropic в названии продукта.
- ВЫВОД ДЛЯ АРХИТЕКТУРЫ (писать на странице так):
  · Claude Adapter запускает установленный пользователем немодифицированный `claude`. Вход — `claude` → `/login`, делает сам пользователь.
  · Пульт не читает `~/.claude/.credentials.json` и keychain, не показывает свою форму входа claude.ai.
  · Флаг `--bare` не использовать: в этом режиме CLI не читает подписочные креды, только ANTHROPIC_API_KEY.
  · Для личного инструмента риска нет. Для продукта на раздачу — нужны Commercial Terms и честная формулировка «запускает Claude Code».

### Протокол управления (code.claude.com/docs/en/headless.md)
- Запуск: `claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages`
- Сессии: `--session-id <uuid>`, `--resume <id>`, `--fork-session`
- Модель и агенты: `--model <alias|id>`, `--agents '<json>'`, `--add-dir <path>`
- Разрешения: `--permission-mode …`, `--permission-prompt-tool <mcp-tool>` (запросы разрешений уходят в MCP-инструмент хоста;
  в Agent SDK аналог — колбэк `canUseTool`)
- Worktree встроен: `--worktree <name>` / `-w` (папка `.claude/worktrees/<name>/`)
- Типы сообщений в потоке: `system` (subtype `init`, `api_retry`), `assistant`, `user` (tool_result), `stream_event`
  (частичные дельты), `result` (итог, `total_cost_usd`, usage, `structured_output` при `--json-schema`, `permission_denials`)
- Структурный выход ноды: `--json-schema` → поле `structured_output` в `result`. Это и есть «контракт стрелки».

### Видимость субагентов
- У сообщений субагента поле `parent_tool_use_id` = id вызова Agent-инструмента, который его породил; у основной беседы `null`.
  Вложенные субагенты несут id своего родителя → дерево восстанавливается по цепочке.
- `--forward-subagent-text` — чтобы в поток шёл и текст субагентов, а не только их tool_use/tool_result.
- Хуки `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`; в Agent SDK хуки регистрируются кодом (`Options.hooks`).
- Транскрипты `~/.claude/projects/<slug>/<session>.jsonl` — НЕ источник для реплея: документация прямо говорит, что формат
  внутренний и ломается между версиями. Реплей строим из собственного журнала событий. (Это подтверждает решение про Event Store.)

### Лимиты подписки
- В потоке stream-json нет события о лимитах и нет поля «осталось».
- Единственная документированная машинная форма — JSON, который CLI отдаёт скрипту статус-строки:
  `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at`,
  `rate_limits.seven_day.used_percentage`, `rate_limits.seven_day.resets_at` (code.claude.com/docs/en/statusline.md)
- Тексты отказа: `You've hit your session limit · resets 3:45pm`, `You've hit your weekly limit · resets Mon 12:00am`.
- Встроенное «подождать сброса лимита» НЕ работает для `-p` и фоновых сессий → headless-прогон просто падает.
  ВЫВОД: пауза и продолжение после лимита — обязанность Quota & Failover в Пульте. Это реальная ценность, а не украшение.

### Что уже есть у самого Claude Code (не изобретать)
- `claude agents --json` — список фоновых сессий: `id, state (working|blocked|done|failed|stopped), waitingFor, sessionId, cwd`
- `claude --bg "prompt"`, `claude attach|logs|stop|respawn <id>`; фоновые сессии сами изолируются в worktree.
- Agent teams — экспериментальные и под `-p` не работают → для Пульта не годятся, оркестрация своя.

## Codex CLI (проверено по learn.chatgpt.com/docs и github.com/openai/codex, 18.09.2026)

### Интерфейсы
- `codex app-server` — двунаправленный JSON-RPC 2.0 по stdio. Официальная формулировка: «Codex app-server is the interface
  Codex uses to power rich clients (for example, the Codex VS Code extension). Use it when you want a deep integration inside
  your own product: authentication, conversation history, approvals, and streamed agent events.»
  Методы: `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `account/read`. Запросы разрешений приходят от сервера
  клиенту (`execCommandApproval`, `applyPatchApproval`), клиент отвечает решением. Стрим: `item/started`, `item/completed`,
  `item/agentMessage/delta`, `turn/completed`. → ЭТО ОСНОВА Codex Adapter.
- `codex exec --json` — JSONL-поток для разовых прогонов: `thread.started`, `turn.started`, `turn.completed` (usage),
  `item.started`, `item.completed` (agent_message, reasoning, command_execution, file_change, mcp_tool_call), `error`.
  Resume: `codex exec resume <SESSION_ID>`. → годится для Shell-подобных нод без разрешений.
- `@openai/codex-sdk` (TypeScript) — `startThread()`, `resumeThread(id)`, `runStreamed()`. Официально — для CI и автоматизации.
- `codex mcp-server` УДАЛЁН. На нём не строить.
- У Codex теперь есть свои субагенты: TOML-файлы в `.codex/agents/` и `~/.codex/agents/` (`name`, `description`,
  `developer_instructions`, опционально `model`, `model_reasoning_effort`, `sandbox_mode`). Это те самые файлы,
  которые у владельца генерирует `sync_codex_agents.py`.

### Вход и правила
- «Sign in with ChatGPT» → креды в `~/.codex/auth.json` (или системное хранилище). Один и тот же вход работает для exec,
  app-server и SDK. `CODEX_HOME` изолирует аккаунт целиком.
- Правила OpenAI про сторонние оболочки над ChatGPT-входом: ЯВНОГО официального заявления НЕ НАЙДЕНО. CLI под Apache-2.0,
  app-server прямо описан как интерфейс «inside your own product». Это серая зона мягче, чем у Anthropic, но без гарантии.
  На странице писать честно: «явного правила нет; перед публичным выпуском перечитать Terms of Use».

### Флаги
- Модель: `-m` / `--model`. Усилие: `-c model_reasoning_effort=minimal|low|medium|high|xhigh`.
- Песочница: `-s read-only|workspace-write|danger-full-access`. Разрешения: `-a on-request|never`. Папка: `-C <dir>`.

### Лимиты
- События `token_count` несут `rate_limits {used_percent, window_minutes, resets_at}`. Есть открытый баг: в `codex exec --json`
  поле приходит `null` (github.com/openai/codex/issues/14728). Через app-server — не проверено. → пункт проверки Фазы 0.

### Уточнение к SPEC по скиллам
- Реестр сканирует ВСЕ места: `.agents/skills`, `.claude/skills`, `~/.claude/skills`, `.codex/skills`, `~/.codex/skills`,
  `.claude/agents`, `.codex/agents`, `~/.codex/agents`. (В SPEC список короче — использовать этот.)

## Рынок (раздел 11 страницы)

Компактная таблица. Колонки: Продукт · Что это · Дерево субагентов · Доска нод · Claude + Codex · Несколько репо.
Значения: да / нет / частично / «?» (не удалось проверить). Строки:
- Claude Desktop, вкладка Code · официальное приложение, параллельные сессии в worktree · нет (только родительские сессии) · нет · нет, только Claude · частично
- Codex desktop app · официальное приложение OpenAI · нет · нет · нет, только Codex · частично
- Conductor · Mac-приложение, параллельные агенты в worktree, дифф → PR · ? · нет · да · ?
- Nimbalyst (бывший Crystal) · параллельные сессии, сравнение подходов, канбан · нет · нет · да · да
- Vibe Kanban · канбан-оркестратор; компания закрыла проект в апреле 2026, ведёт сообщество · нет · нет · да · частично
- CodeLayer / HumanLayer · «control plane» для команд, 100 $ за место в Pro · частично · нет · да · да
- herdr · мультиплексор терминалов для агентов · частично (плоские статусы) · нет · да · частично
- Warp · терминал, запускает настоящие CLI в панелях · нет · нет · да · частично
- easy-vibe-kanban · форк Vibe Kanban с холстом воркфлоу, одна нода = один агент · частично · да · да · ?
- FlowCoder · визуальный конструктор блок-схем для Claude Code и Codex, маленький инди-проект · ? · да · да · нет
- claude-devtools · читает логи `~/.claude`, рисует вложенное дерево субагентов с токенами · да (только чтение) · нет · нет · нет
- Pane · терминальный оркестратор «across repositories, panes, tabs, worktrees» · ? · нет · да · да

Абзац «Где щель» (писать так, без хвастовства):
Параллельные сессии в worktree уже умеют все, включая само приложение Claude. Этим не выделиться.
Не нашлось ни одного инструмента, который сразу: даёт редактируемую доску нод, выбор модели на каждой ноде,
живое вложенное дерево субагентов внутри ноды, оба провайдера на подписках и одну доску веток по нескольким репозиториям.
Конструкторы флоу (easy-vibe-kanban, FlowCoder) видят ноду как чёрный ящик. Просмотрщики дерева (claude-devtools) только читают
логи и ничего не запускают. Часть ячеек таблицы проверить не удалось, поэтому вывод осторожный: прямого конкурента не нашли,
а не «его нет».
Отсюда правило приоритета: сила Пульта — связка «доска + рентген ноды + два провайдера», а не ещё один менеджер worktree.

Изменение в SPEC, раздел 10 «Риски», первая строка — заменить на две строки:
- Правила Anthropic о подписке в сторонних приложениях · С февраля 2026 запрещено предлагать вход claude.ai в своём приложении
  и трогать токены; с 4 апреля 2026 это принудительно. Запуск немодифицированного `claude`, в который пользователь вошёл сам,
  разрешён явно. · Адаптер запускает установленный пользователем `claude` и не читает его креды. Для публичного продукта —
  Commercial Terms, без имени Claude в названии. Запасной вход по API-ключу.
- Правила OpenAI · Явного правила про сторонние оболочки нет; `codex app-server` официально описан как интерфейс для чужих
  продуктов. · Строим на app-server. Перед публичным выпуском перечитать Terms of Use.
И добавить строку:
- Headless-сессия Claude падает на лимите, встроенного ожидания нет · Документация: ожидание сброса недоступно для `-p` и
  фоновых сессий · Quota & Failover сам ставит ноду на паузу и возобновляет через `--resume` после `resets_at`.

Уточнение к Диаграмме A (подписи стрелок):
- Claude Adapter → `claude`: «`claude -p` · stream-json в обе стороны · `parent_tool_use_id` → дерево»
- Codex Adapter → `codex`: «`codex app-server` · JSON-RPC по stdio · approvals»
- Quota & Failover → `claude`: пунктир «лимиты: JSON статус-строки»
Уточнение к Фазе 0 (пять пунктов проверки заменить на шесть): поток событий · ответ на запрос разрешения · resume ·
видимость субагента · структурный выход по JSON-схеме · чтение лимитов подписки.

## Codex: уточнённые факты из исходников openai/codex и learn.chatgpt.com (проверены в первом заходе, codex-cli 0.155.0) — ЭТО НЕ ВЫДУМКА, страница обязана их содержать
- Цитата (learn.chatgpt.com/docs/app-server), дословно: "The app-server command and WebSocket transport are experimental and aren't supported for production workloads."
  Локально подтверждено: `codex app-server --help` начинается с «[experimental] Run the app server or related tooling».
- Методы app-server (codex-rs/app-server-protocol): `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, `turn/start`, `turn/steer`,
  `turn/interrupt`, `account/read` (в ответе `planType`), `account/login/start` с `type: "chatgpt"`, `account/rateLimits/read`, уведомление `account/rateLimits/updated`.
- Запросы разрешений от сервера клиенту: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`.
  Ответы клиента: `accept | acceptForSession | decline | cancel`.
- Субагенты Codex видны в потоке событий как элементы типа `collab_tool_call` с инструментами `spawn_agent`, `send_input`, `wait`, `close_agent` и статусами
  по каждому агенту (codex-rs/exec/src/exec_events.rs) — источник для ветки Codex в дереве агентов.
- `@openai/codex-sdk` — обёртка, которая запускает `codex exec --experimental-json`; разрешений посреди хода у неё нет.
- Схема ответа: `turn/start.params.outputSchema`; в exec-режиме `--output-schema <FILE>` (проверено локально в `codex exec --help`).
- Снимок лимитов: `primary`/`secondary` с `usedPercent`, `windowDurationMins`, `resetsAt`; признак блокировки — `rateLimitReachedType`.
- `Turn.status`: `completed | interrupted | failed | inProgress`; `Turn.error` заполнен при `failed`.

## ИСТОЧНИКИ ФАКТОВ ДЛЯ ПРОВЕРЯЮЩИХ (важно)
Фактами считаются утверждения из ЛЮБОГО из файлов: FACTS.md, DELTA.md, DELTA3.md, а также из отчётов ресёрча wf1.json, wf4.json (с вердиктами проверяющих) и критики wf2.json, wf5.json.
Утверждение НЕ является выдумкой только потому, что его нет в FACTS.md. Выдумка — то, чего нет ни в одном из этих файлов.

## opencode 1.18.31 — снято с живого локального `GET /doc` и проверено (20.09.2026)
- `opencode serve` — OpenAPI 3.1 на `GET /doc`, 162 пути; SSE `GET /event` (первое событие `server.connected`), также `/global/event`, `/api/event`.
- Реплика: `POST /session/{id}/message` (синхронно), `POST /session/{id}/prompt_async` (204), `POST /api/session/{id}/prompt` (только приём).
- Разрешения: события `permission.v2.asked` / `permission.v2.replied`; ответ `POST /api/session/{id}/permission/{requestID}/reply`; `POST /session/{id}/permissions/{id}` — deprecated.
- Остановка: `POST /session/{id}/abort`, `POST /api/session/{id}/interrupt`. Вопросы: `question.v2.asked / replied / rejected`.
- Части сообщения: `text, subtask, reasoning, file, tool, step-start, step-finish, snapshot, patch, agent, retry, compaction`; `ToolState`: `pending | running | completed | error`.
- Субагенты: часть `subtask` {prompt, description, agent, model}, `Session.parentID`, `GET /session/{id}/children`.
- Статус: `session.status` = `idle | busy | retry` (в `retry`: attempt, message, action{reason, provider, …}, next).
- Схема ответа: `format: {type: "json_schema", schema, retryCount?}` → `AssistantMessage.structured`; ошибка `StructuredOutputError`.
- Папка — query-параметр `directory` на каждом пути; `workspace` — экспериментальные `/experimental/workspace*`.
- Авторизация: в схеме нет `securitySchemes`; у `serve` флаги только `--port --hostname --mdns --mdns-domain --cors`; в бинаре есть `OPENCODE_SERVER_PASSWORD` и `OPENCODE_SERVER_USERNAME`.
- Данные: `~/.local/share/opencode/opencode.db`, `auth.json` (не читать). Проверка входа: `opencode providers list`.
- Прокси: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`; документация предупреждает о петле для локального сервера.
- Claude Code network-config, дословно: "Claude Code does not support SOCKS proxies."
