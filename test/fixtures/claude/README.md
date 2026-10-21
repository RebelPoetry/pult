# Фикстуры Claude — сырые потоки `claude --output-format stream-json`

Что это. Каждый `*.jsonl` — **дословный stdout** настоящего `claude` (или синтетика, помеченная
ниже), строка = одно событие. Рядом `*.timing.json` — массив смещений в миллисекундах по
строкам: по нему `test/fakes/fake-claude.mjs` отыгрывает поток с настоящим ритмом, только
быстрее (делитель `PULT_FAKE_SPEED`).

- CLI: **Claude Code 2.1.278** (`/opt/homebrew/bin/claude`), модель `haiku`, усилие `low`.
- Дата записи: **21.09.2026**.
- Чем записано: `node scripts/record-claude-fixtures.mjs [сценарий …]` (страж страны выхода —
  тот же код, что у адаптера; `cwd` — одноразовый git-репозиторий под `os.tmpdir()`).
  Синтетика — `node scripts/synth-claude-fixtures.mjs`.
- Редакция: рекордер заменяет адреса почты на `<email>`. При записи 21.09.2026 **ни одной
  замены не потребовалось**. Перед открытием кода (14.10.2026) записи вычищены руками: домашний
  путь — `/Users/you`, личная временная папка macOS — `/var/folders/xy/0000…gn`, каждый uuid
  заменён на другой одной и той же подстановкой во всём дереве (тесты и записи согласованы), из
  `system/init` убраны личные агенты, плагины организации и подключённые сервисы claude.ai
  (`agents`, `skills`, `slash_commands`, `plugins`, `mcp_servers`). Id сообщений (`msg_…`) — как есть.
- В CI рекордер не запускается никогда: ему нужен залогиненный `claude`, сеть и квота.

Базовый argv (все сценарии, кроме разрешений):

```
-p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --forward-subagent-text
(--session-id <uuid> | --resume <uuid>) --model haiku --effort low
--setting-sources user --permission-prompts none
```

| Файл | Как записан | Настоящий? | Что внутри |
|------|-------------|-----------|------------|
| `01-simple-turn.jsonl` | 1 ход, процесс на ход | да | `system/init`, `system/status`, `stream_event` (message_start, content_block_start/delta/stop, message_delta, message_stop), два `assistant` (thinking и text), `rate_limit_event`, `result`. Ответ модели — `PULT` |
| `02-warm-two-turns.jsonl` | 2 хода в ОДНОМ процессе, stdin не закрывался | да | тот же поток дважды подряд; второй ход помнит контекст (`41`). Задержка второй реплики при записи — 1361 мс |
| `03-resume-turn1.jsonl` | 1 ход, процесс закрыт | да | закладывает кодовое слово `MAYAK` |
| `03-resume-turn2.jsonl` | НОВЫЙ процесс с `--resume <тот же uuid>` | да | вспоминает `MAYAK`; `session_id` в событиях совпадает с ходом 1 |
| `04-permission-deny-allow.jsonl` | 2 хода через `--permission-prompt-tool mcp__pult__ask` | да | ход 1: `Edit` → ОТКАЗ, файл не тронут, `result.permission_denials[0].tool_name == "Edit"`, `is_error: false`; ход 2: `Edit` → РАЗРЕШЕНИЕ, правка применена |
| `04-permission-mcp-trace.jsonl` | трасса JSON-RPC со стороны MCP-заглушки | да | `initialize` → `notifications/initialized` → `tools/list` → три `tools/call` с аргументами `{tool_name, input, tool_use_id}` и `_meta.claudecode/toolUseId` |
| `05-permission-bash-deny.jsonl` | 3-й ход того же процесса, нарезан по `result` | да | `Bash` с записью (`touch probe.txt`) СПРАШИВАЕТ; вход — `{command, description?}`; отказ → `permission_denials[0].tool_name == "Bash"` |
| `06-subagent.jsonl` | 1 ход + `--allowedTools Agent Task`, stdin держали открытым 90 с | да | `Agent` `tool_use` (`subagent_type: "Explore"`), `tool_result` «Async agent launched successfully», первый `result` с `subagent_stats.started_in_background: 1` — **и через 4 мс ВТОРОЙ ход** (`system/init` → `assistant` `DONE` → второй `result`). См. `06-subagent.experiment.json` |
| `07-api-retry-storm.jsonl` | `HTTPS_PROXY=http://127.0.0.1:9`, убит на третьем повторе | да (0 токенов) | `system/init`, `system/status`, три `system/api_retry` с полями `attempt`, `max_retries: 10`, `retry_delay_ms`, `error_status`, `error` |
| `08-not-logged-in.jsonl` | **СИНТЕТИКА** | нет | форма из `spike/claude/offline/probe-notloggedin.mjs`: `assistant` с `error: "authentication_failed"`, `is_api_error_message: true`, текст `Failed to authenticate: OAuth session expired and could not be refreshed`; `result` — `is_error: true`, `terminal_reason: "api_error"`, но `subtype: "success"` |
| `09-account-region-block.jsonl` | **СИНТЕТИКА** | нет | дословный текст из `docs/06-DELTA-v0.5-spike-claude.md` §1: `Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access`, `api_error_status: 403` |
| `10-resume-no-conversation.jsonl` | `claude -p --session-id U` убит SIGINT на 0,55 с (0 строк stdout), затем `claude -p --resume U` | да | **две строки, первая — НЕ JSON**: `No conversation found with session ID: <uuid>`. Вторая — `result` с `subtype: "error_during_execution"`, `is_error: true`, `num_turns: 0`, `total_cost_usd: 0`, **без полей `result` и `terminal_reason`**; причина лежит в `errors[0]`. Сохранён дословно, побайтно |
| `11-resume-after-background.jsonl` | 07.10.2026, CLI **2.1.291**: ход с фоновым субагентом (`sleep 40`), процесс снят через 1,5 с после первого `result`; через 3 с НОВЫЙ процесс `--resume` с репликой «Reply with exactly PONG.» | да | **на одну реплику — два хода.** Сначала разгрузка: `system/task_notification` (`status: "stopped"`, «didn't finish before the previous session ended») → `system/init` → `result` с `num_turns: 0`, пустым `result`, 0 токенов. Потом второй `system/init` и настоящий ответ `PONG` (`num_turns: 1`). Сценарии `resume-drain` (оба хода) и `resume-drain-stuck` (только разгрузка) |
| `12-background-live.jsonl` | 07.10.2026, CLI 2.1.291: ОДИН процесс, stdin открыт 75 с; ход 1 запускает фоновый субагент (`sleep 25`), через 3 с после его `result` — реплика «Reply with exactly PONG.» | да, **без `stream_event`**, тайминг синтетический (10 мс на строку) | `system/background_tasks_changed {tasks:[…]}` — полный список живых фоновых задач на каждый старт и конец; `task_started` / `task_progress` / `task_updated` / `task_notification`; PONG отвечен живым процессом за секунду при идущем субагенте; затем CLI САМ отыгрывает два хода-итога (`init` → `assistant` → `result`), последний — `SUB-DONE`; финальный список задач пуст. Сценарий `background-live` (`autoFrom: 2`) |
| `13-resume-phantom-result.jsonl` | 08.10.2026, CLI **2.1.294**: ход 1 (`--session-id`) запускает ДВА фоновых субагента (`sleep 120`), процесс снят SIGTERM через 2 с после `result`; через 3 с НОВЫЙ процесс `--resume` (`--allowedTools Agent Task Bash`), реплика «Reply with exactly PONG.» **с полем `uuid`** | да, тайминг настоящий | `task_notification` ×2 (`stopped`) → `command_lifecycle` `queued` (наша метка в `command_uuid`) → `init` → **чужой** `result` (`num_turns: 0`, пусто, **без `user_message_uuids`**) → `command_lifecycle` `started` → `init` → `status` с `user_message_uuids` → PONG → `result` с `user_message_uuids: [метка]` → `completed`. Сценарии `resume-phantom`, `resume-phantom-stuck` и `resume-phantom-twice` (переигровка: чужой ход дважды, повтор без уведомлений — форма из журнала Пульта 07–08.10) |
| `14-local-command.jsonl` | 08.10.2026, CLI 2.1.294: новый процесс, реплика `/cost` с полем `uuid` | да, **текст обрезан**, тайминг синтетический (10 мс на строку) | НАСТОЯЩИЙ ответ на реплику с `num_turns: 0`: `queued` → `started` → `init` → `assistant` (`model: "<synthetic>"`) → `result` с `local_command: "cost"` и `user_message_uuids: [метка]` → `completed`. Вывод `/cost` (проценты лимитов и профиль расхода владельца) урезан до первой строки в `assistant`, `local_command_source` и `result`. Сценарий `local-command` |
| `90-demo-working.jsonl` | **ДЕМО окна** (Ф2) | нет | ход «идёт»: `Read` закончен, субагент `Explore` с `Grep` внутри и дельтами текста, дальше пауза 10 мин по таймингу — окно снимают в состоянии «идёт». Формы — из 01, 04, 06 |
| `91-demo-edit.jsonl`, `91-demo-edit-denied.jsonl` | **ДЕМО окна** (Ф2) | нет | реплика модели, затем `Edit` с `old_string`/`new_string` — сценарий `demo-edit` спрашивает разрешение НА ЭТОЙ строке (`askInline`); при отказе ход доигрывается хвостом `-denied` |

## Чем важны 13 и 14

Реплика в stdin может нести поле `uuid` (метку). Тогда CLI 2.1.294 метит ею свой ответ:
`result.user_message_uuids` и события `command_lifecycle` (`queued` → `started` → `completed`).
Без метки ни того ни другого нет — поэтому в записях 01–12 их и нет. Ход, который CLI отыгрывает
сам (разгрузка уведомлений фоновых задач прошлого процесса), метки не несёт: по ней адаптер
отличает чужой `result` от ответа на реплику, а `num_turns: 0` для этого не годится — `/cost`
(14) отвечает именно так. Фальшивый CLI подменяет записанную метку на метку пришедшей реплики.

13 и 14 записаны вручную, не рекордером, одноразовым скриптом той же формы (страж страны выхода,
`cwd` — одноразовый git-репозиторий под `os.tmpdir()`); при перезаписи фикстур рекордером они не
появятся.

## Чем важна 10

Ход, убитый до `system/init`, не оставляет на диске НИЧЕГО: папки `~/.claude/projects/<cwd>/`
не появляется вовсе. Значит `--resume` по выданному нами uuid обречён, и `10` — дословный
ответ CLI на такую попытку. Именно по ней адаптер решает, что разговор надо заводить заново
(`NO_CONVERSATION_RE` в `src/adapters/claude/mapper.ts`). Обратный случай — `--session-id` с
уже существующим разговором — НЕ измерен, и поведения на него в коде нет.

Записана вручную (не рекордером), поэтому `10` не появится при перезаписи фикстур ниже:

```sh
claude -p --output-format stream-json --verbose --session-id "$U" 'привет'   # убить на ~0,5 с
claude -p --output-format stream-json --verbose --resume     "$U" 'привет'   # это и есть запись
```

## Почему 08 и 09 синтетические

`08` воспроизводится только выходом владельца из аккаунта (`claude logout`) — он потеряет
рабочую сессию ради одной фикстуры. `09` зависит от отказа платформы: 21.09.2026 его наблюдали
в течение ~15 минут, по требованию он не повторяется. Обе собраны из **измеренных** полей, а
конверты `system/init` и `result` взяты из настоящей записи `01-simple-turn.jsonl`.

## Как перезаписать под новую версию CLI

```sh
npm run build
node scripts/record-claude-fixtures.mjs            # все настоящие сценарии, ~9 ходов haiku
node scripts/record-claude-fixtures.mjs permission # или по одному
node scripts/synth-claude-fixtures.mjs             # 08 и 09
```

Версию CLI в шапке этого файла обновить руками — `claude --version`.
