# DELTA — спайк Hermes через ACP (26.09.2026)

Вопрос: может ли Hermes Agent (Nous Research) стать провайдером №4 Пульта через ACP (вариант A из
внешнего разбора Hermes Agent, 26.09, вне репозитория) и дать владельцу свою память, самописные скиллы и `delegate_task`.
Замер: hermes-agent 0.21.5 (тег `v2026.9.24`, коммит `f97608f`), плагин `claude-subscription-directsdk` 0.3.0
(коммит `72dfaa4`), `agent-client-protocol` 0.9.0, Claude Code 2.1.282, модель haiku (`claude-haiku-4-5-20251001`), macOS, VPN — TUN `utun10`.
Источники: транскрипты и итоги шагов зондов (журналы и таблицы прогонов в публичное дерево не входят (scripts/public-exclude.txt)), как повторить — `spike/hermes/README.md`.

Два прохода:
- **Первый** — живые ходы: 10 промптов через Hermes (15 вызовов модели, считая ребёнка `delegate_task`) и 2 хода через `claude` Пульта.
  Страна выхода перед каждым шагом — FI.
- **Второй** — ноль вызовов модели: бюджет живых ходов исчерпан (12/12). Настоящие `hermes acp`, плагин и `claude`, но
  единственное соединение relay плагина с `api.anthropic.com` уводится в локальную заглушку Messages API
  (`spike/hermes/lab/sitecustomize.py`), а `claude` работает с ключом-фикстурой и пустым `CLAUDE_CONFIG_DIR`
  (`lab/claude-fixture.sh`). Зонд — `spike/hermes/stub-probe.mjs`, файлы `logs/stub-*`. Страна выхода — FI в 14 проверках из 14.

## 0. Итог

**Ворота открыты с оговорками, но в текущей конфигурации по умолчанию Hermes подключать нельзя.** K1, K3 и K4 пройдены,
K2 пройден с правилом адаптера, которое опирается на текст реплики, K5 пройден по объёму (≈0,55× токенов пути `claude`), а цена в долларах
не измерена. Второй проход нашёл главное: **Hermes по умолчанию сам читает вход Claude Code из Keychain и
`~/.claude/.credentials.json` и ходит с этим OAuth-токеном на `api.anthropic.com/v1/models`**. Так же он берёт токен GitHub через
`gh`, даже если `gh` нет в `PATH`. Оба источника выключаются конфигом (§4, «Окружение и конфиг»), и без этого адаптер нарушает инвариант 7.
`delegate_task` через ACP **не работает**: ответ фонового ребёнка не доставляется никогда.

## 1. S1–S8

| № | Проверка | Итог | Решающая строка |
|---|---|---|---|
| S1 | Старт, `initialize`, версия | работает | ответ `initialize` через 0,7–1,3 с после spawn; `loadSession: true`, `sessionCapabilities {fork, list, resume}`, `protocolVersion: 1`, `agentInfo.version "0.21.5"`; первый `session/new` 20,6 с (ленивые установки), дальше 1,4–2,4 с |
| S2 | Простой ход «OK» | работает | `stopReason: "end_turn"`, `usage {inputTokens: 12807, outputTokens: 44, …}`; первый и единственный `agent_message_chunk` через ~3,6 с (±0,13 с — погрешность сэмплера, §6) |
| S3 | Полнота гейта (`approvals.mode: manual`) | частично | `rm -rf`, `find -delete`, `python3 -c shutil.rmtree` → `session/request_permission`; `rm файл`, `mv`, `truncate`, `ls`, `sleep` выполняются **без** запроса (`stub-k1-summary.json`) |
| S4 | `session/cancel` | работает | посреди `sleep 25` → `stopReason: "cancelled"` через 0,3 с, инструмент `exit_code: 130`; при висящем разрешении → `cancelled` через 3,7 с, команда не выполнена |
| S5 | Рестарт → `session/load` | работает | после **SIGKILL** (второй проход; в первом был SIGTERM) сессия грузится и помнит прошлые ходы; реплей целиком до ответа (`respAt`: 2 из 2). cwd **не** восстанавливается: побеждает `cwd` из `session/load` |
| S6 | Egress | частично | системный `nettop`: все внешние потоки процессов Hermes — через `utun10`. relay плагина `HTTPS_PROXY` игнорирует (`set_tunnel` не вызван), а `claude` с `HTTP_PROXY` шлёт свой запрос к relay на 127.0.0.1 через прокси, и ход падает |
| S7 | Разлогиненный `claude` | работает (провал виден) | `end_turn` без `usage`, реплика «…didn't answer after 3 attempts… no usable login…», stderr `error_type=ClaudeCodeLoggedOut` |
| S8 | Цена против пути `claude` Пульта | частично | та же задача из 3 ходов на заглушке: Hermes 237,8 КБ за 7 запросов, `claude` Пульта 603,4 КБ за 5 запросов; в токенах ≈0,55×. Цена в $ не измерена |
| — | `delegate_task` (доп.) | не работает | ответ ребёнка (`CHILD-ANSWER-7731`) не пришёл ни в простое 30 с, ни в следующий ход, ни после рестарта; `delivery_state` остаётся `pending`, `delivery_attempts` — 0 |

## 2. Критерии остановки

| К | Итог | Доказательство |
|---|---|---|
| K1 гейт на `rm -rf` | пройден в формулировке критерия | `rm -rf` спрашивает и в боевом конфиге (tirith выключен): `perm-check-1`, после `deny` папка на месте. Но гейт — denylist регулярок: 15 из 25 разрушительных команд под гейтом, мимо него идут `rm файл`, `mv`, `truncate`, `> файл`, `git checkout -- .` (`k1-battery-summary.json`). Ответ `allow_always` пишет `command_allowlist: [recursive delete]` в `config.yaml`: дальше `rm -rf` проходит без спроса во всех сессиях |
| K2 провал отличим от успеха | пройден с правилом | 429: `end_turn` без `usage` и реплика «… rate-limited every one of 3 attempts … Provider said: … status 429 …»; разлогин — «… didn't answer after 3 attempts … no usable login …». Без `usage` кончаются и `/help`, и пустой промпт, и промпт во время хода: по одному `usage` провал не распознать. В строках stderr id сессии нет, только `thread=acp-agent_N`. 529: пять циклов повторов, ответа нет дольше 4 минут |
| K3 выход мимо туннеля | пройден | лид: TUN `utun10`, `loc=XX`; 14 проверок страны второго прохода — FI; `nettop` по всей системе: у процессов Hermes внешних потоков вне `utun10` нет |
| K4 восстановление сессии | пройден | SIGKILL простаивающего процесса → `session/load` OK, следующий запрос содержит прошлый ход. SIGKILL посреди `sleep 20` → load OK, но от прерванного хода остаётся только реплика пользователя: вызов инструмента теряется |
| K5 цена ≤ 2× | пройден по объёму, цена не измерена | та же задача из 3 ходов на заглушке: по байтам 0,39×, в токенах ≈0,55× (калибровка по живым ходам первого прохода). Долларовые 1,22× и 0,35× из первого прохода недействительны: у пар противоположное состояние кэша, а «ls ≈$0,0095» взят из сессии S4 |

## 3. Что спайк нашёл сверх K1–K5

Каждое — отдельная строка «адаптер обязан», иначе нарушен инвариант.

- **Заимствование входа Claude Code (инв. 7, самое важное).** Для каталога моделей `anthropic:*` Hermes вызывает
  `resolve_anthropic_token()`. Функция читает Keychain (`security find-generic-password -s "Claude Code-credentials" -w`)
  и `~/.claude/.credentials.json`, затем шлёт `GET api.anthropic.com/v1/models` с `Authorization: Bearer <OAuth владельца>`
  (`hermes_cli/models.py` `_fetch_anthropic_models`). Второй проход поймал это дважды: заглушка получила `GET /v1/models` с заголовком
  `authorization`, отказала и значение не записала (`stub-k5-upstream.jsonl` №8, `stub-review-upstream.jsonl` №1). В первом проходе
  на старте S1, ещё до хода, Python уже держал соединение с `160.79.104.10`: скорее всего, это был тот же запрос к настоящему Anthropic.
  Hermes умеет и **обновлять** этот токен и писать его обратно в Keychain. Refresh-токен одноразовый, поэтому это может разлогинить
  терминальный `claude`. Выключатель — `auth.adopt_external_logins: false`: он проверен (`stub-adopt-summary.json` — ноль
  запросов, в `availableModels` только `claude-subscription-directsdk-experimental:*`, в stderr «External CLI logins … are not adopted»).
  Тот же выключатель закрывает `~/.codex/auth.json`.
- **Токен GitHub (инв. 1 и 7).** Если убрать `gh` из `PATH`, это не помогает: `hermes_cli/copilot_auth.py` ищет `gh` ещё и в каталогах Homebrew.
  Hermes обменивает токен на `api.github.com` (поток `copilot-token-exchange`) и ходит на `api.githubcopilot.com` — это видно в прогонах k2, k5 и adopt.
  Выключатель — `suppressed_sources.copilot: [gh_cli, env:COPILOT_GITHUB_TOKEN, env:GH_TOKEN, env:GITHUB_TOKEN]` в
  `auth.json`: проверен (`stub-ghsuppress-summary.json` — ноль соединений с GitHub, пул `copilot` не создаётся).
- **Вход терминального `claude` — Team, а не Max.** `claude auth status --json` → `subscriptionType: "team"`, `authMethod: "claude.ai"`
  (`stub-auth-summary.json`, только эти поля). Плагин тратит ту подписку, на которую залогинен терминальный `claude`.
- **Ленивые установки с PyPI (инв. 8).** `Lazy-installing boto3…`, `google-auth…` на первом `session/new`. Выключатель — `HERMES_DISABLE_LAZY_INSTALLS=1`.
- **`tirith` — бинарь последней версии из интернета (инв. 8).** Ходит на GitHub и после установки (`nettop` второго прохода: `tirith` →
  `185.199.x`, `140.82.121.3` в прогоне с конфигом первого прохода). Выключатель — `security.tirith_enabled: false`. В боевом конфиге
  внешних потоков от `tirith` нет.
- **`delegate_task` всегда фоновый, а у ACP нет потребителя результатов.** Верхнеуровневое делегирование всегда уходит в фон:
  `run_agent._dispatch_delegate_task` игнорирует параметр `background`. Результат ложится в `process_registry.completion_queue`,
  а `acp_adapter` никогда не зовёт `drain_notifications`. Синхронный путь включают только `HERMES_SINGLE_QUERY_SESSION=1`
  (меняет режим одобрений) и `HERMES_KANBAN_TASK`. Оба — чужие режимы, не для Пульта.
- **Повторный промпт в идущий ход его перенаправляет.** Второй `session/prompt` в занятую сессию сразу отвечает `end_turn` с текстом
  «Redirected the active turn with your correction.», а первый ход продолжается с новой репликой. Адаптер обязан держать очередь сам.
- **529 Overloaded — ход висит больше 4 минут.** Пять циклов «auto-recovery» по 3 попытки с паузами 18/33/70/71/63 с; в ACP за это
  время ни одного обновления, только stderr `Provider unavailable (overloaded) — auto-recovery cycle n/5`.
- **Модель думает, что её cwd — временная папка плагина** (`…/claude-directsdk-cwd-…`), хотя инструменты Hermes работают в cwd сессии.
- **Долгоживущие соединения мимо туннеля.** `nettop` показал у давно запущенного интерактивного `claude` (не процесса Hermes) поток к
  `160.79.104.10` через `en0` рядом с потоками через `utun10`: соединение, открытое до подъёма TUN, так и живёт вне туннеля.
  Страж страны через `curl` такое не видит.
- **Расхождения с исследованием.** Тег 0.21.5 не на PyPI (там 0.19.0), колесо из git не собирается, без extra `[acp]` адаптер не стартует;
  `requires-python` — `<3.14`; плагин переприпнут 26.09; чужой id в `session/load` даёт `{}`, а не `null`.

## 4. Что это значит для адаптера

**Окружение и конфиг**
- Один `hermes acp` на демон, сессии Пульта = ACP `sessionId`. Холодный старт до ответа `initialize` — 0,7–1,3 с; `session/new` 1,4–2,4 с.
- Окружение ребёнка: белый список + `HERMES_HOME=$PULT_HOME/hermes`, `HERMES_ACP_SKIP_CONFIGURED_MCP=1`, `HERMES_DISABLE_LAZY_INSTALLS=1`,
  `TMPDIR`, `UV_CACHE_DIR`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` под `PULT_HOME`. **Никаких `HTTP_PROXY`/`HTTPS_PROXY`**, а если
  профиль сети их требует — `NO_PROXY=127.0.0.1,localhost`: иначе `claude` шлёт запрос к relay плагина через прокси и ход падает
  с ложным «no usable login» (`stub-proxy-summary.json`, вариант `all`).
- `config.yaml`: `approvals.mode: manual`, `approvals.timeout: 3600`, `terminal.backend: local`, `security.tirith_enabled: false`,
  **`auth.adopt_external_logins: false`**, `fallback_providers: []`, `skills.write_approval: true`, `memory.write_approval: true`.
- `auth.json`: `suppressed_sources.copilot` — все четыре источника. `pult doctor` проверяет оба выключателя и отсутствие `command_allowlist` в `config.yaml`.
- Для `delegate_task` — выключить набор `delegation` в сессиях Пульта, пока в Hermes нет потребителя результатов для ACP.
- Установка — клон на коммит и `uv pip install -e '.[acp]'` в venv Пульта; `pult doctor` зовёт `hermes acp --check`.
- Плагин держит `claude` в **своей** группе процессов: гасить по дереву (`pgrep -P`), потом группу. После SIGKILL дерева сиротой не остаётся даже `sleep` инструмента.

**Протокол**
- `initialize`: `{protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}}`.
  `authMethods`: `claude-subscription-directsdk-experimental` и `hermes-setup`; `authenticate` для хода не нужен.
- `session/new {cwd, mcpServers: []}` → `sessionId`, `models.currentModelId: "claude-subscription-directsdk-experimental:haiku"`,
  `modes: default | accept_edits | dont_ask`. Режим — всегда `default` (`accept_edits` пишет файлы без спроса).
- Запросы от сервера нумеруются **с 0** — проверка `if (msg.id)` потеряет первый `session/request_permission`.
- Промпт в занятую сессию не слать: Hermes перенаправит идущий ход. Очередь — на стороне Пульта.

**События `session/update` → Пульт**
- Живой ход: `agent_message_chunk {content.text, messageId}` — один кусок на реплику; `tool_call {toolCallId: "tc-<12hex>", title, kind: execute | edit}`
  без `rawInput`; `tool_call_update {toolCallId, status: completed | failed, content}`; `usage_update {size, used}` — заполнение контекста, не расход;
  `available_commands_update`, `session_info_update`.
- Реплей `session/load` помечать **окном**, а не префиксом id: всё, что пришло между запросом `session/load` и строкой ответа, — реплей
  (`toolu_…` бывает только у инструментов; у текста и мыслей маркера нет). В зонде окно снимается в `handle()` (`respAt`).
- Мостики разрешений закрываются `tool_call_update` с id `perm-check-N` / `edit-approval-N`, для которых не было `tool_call`.

**Расход**
- `PromptResponse.usage {inputTokens, outputTokens, thoughtTokens, cachedReadTokens, totalTokens}` — **нарастающий итог агента сессии**:
  две сессии в одном процессе вперемешку дали A 1000 → 2000, B 50000 → 100000 (`stub-usage-summary.json`). После `session/load` счёт
  начинается с нуля. Расход хода = разность с прошлым ответом **этой же сессии**; ответ без `usage` разность не сбрасывает.
- В `usage` не попадают ни aux-вызовы (заголовок), ни ребёнок `delegate_task`. Полная картина — `state.db`, таблица `sessions`
  (`input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `estimated_cost_usd`, `parent_session_id`).
- Объём на одной и той же задаче (`stub-k5-summary.json`): у Hermes запрос ~46 КБ (system 6,2 КБ + 23 инструмента 38,6 КБ), у `claude`
  Пульта ~120 КБ (system 27,9 КБ + 25 инструментов 81,9 КБ + 9,8 КБ своих напоминаний). Главных запросов поровну: по 5.
  Hermes добавляет 2 запроса заголовка по ~2,6 КБ. Раз в 10 ходов (`nudge_interval` по умолчанию) — фоновый разбор памяти и скиллов:
  +1 запрос с полным контекстом (57 КБ на третьем ходе, `stub-review-summary.json`).

**Разрешения (инв. 5)**
- Команда: `options` = `allow_once`, `allow_session`, `allow_always`, `deny`, `deny_always`. Правка: `allow_once`, `deny`.
  **Отвечать только `allow_once` или `deny`**: `allow_always` навсегда пишет шаблон в `config.yaml` (`command_allowlist`).
  `allow_session` работает так же на время процесса.
- Гейт — denylist регулярок (`tools/approval_detection.py`), а не список разрешённого: `rm файл`, `mv`, `truncate`, `> файл`
  выполняются без спроса. `pult doctor` и документация обязаны это говорить. Граница по файлам — забота worktree Пульта.
- После `session/cancel` висящий запрос сервер не отзывает — адаптер сам отвечает `{outcome: {outcome: "cancelled"}}` и чистит Inbox.

**Отмена и восстановление**
- `session/cancel` → `stopReason: "cancelled"`: 0,3 с посреди инструмента, до 3,7 с при висящем разрешении.
- `session/load {sessionId, cwd, mcpServers: []}`: **cwd берётся из запроса** (`sessions.cwd` у свежей сессии в БД был `null`, после load —
  переданный; `pwd` в следующем ходе — переданный). Пульт хранит cwd сессии сам и передаёт его.
- Падение посреди хода: от хода остаётся только реплика пользователя, вызов инструмента и его результат теряются. Адаптер помечает такой ход
  как прерванный и не считает побочные эффекты (файлы) отменёнными.
- Чужой id: `session/load` → `{}` плюс stderr `load_session: session <id> not found`; `session/prompt` → `stopReason: "refusal"`.

**Провалы**
- Сигнал, привязанный к сессии, — финальная реплика агента в ЭТОЙ сессии, а не stderr. Правило: `end_turn`, нет `usage`, а текст
  начинается с `<Provider label> rate-limited every one of N attempts` (лимит) или `<label> didn't answer after N attempts` (прочее) —
  значит, провал. Хвост `Provider said: …` несёт `status 429` / `no usable login`. `/help`, пустой промпт и перенаправление тоже кончаются без
  `usage`, но этих слов в тексте нет. Текст английский и хрупкий, поэтому на каждую версию Hermes нужны фикстуры.
- stderr: `error_type=ClaudeCodeLoggedOut` у разлогина, `error_type=RuntimeError` с `status 429` у лимита. id сессии в строке нет, есть только
  `thread=acp-agent_N` — при нескольких сессиях строка не привязывается.
- `Retry-After` до Hermes не доходит: плагин передаёт только текст ошибки. Лимит подписки с телом без слов «rate limit» Hermes считает
  обычным провалом. Пауза между попытками — своя, 2–5 с.
- **Свой таймаут хода обязателен:** на 529 Hermes молчит дольше 4 минут. По таймауту — `session/cancel`.

**Сеть (инв. 2)**
- При системном VPN relay плагина не течёт: Python и `claude` выходят через `utun10`. relay игнорирует `HTTPS_PROXY`, поэтому
  на машине с прокси-VPN (без TUN) relay пошёл бы напрямую. На такой машине провайдер Hermes запускать только с `mode: required` и TUN.

## 5. Что ещё не проверено

- Цена в долларах одной и той же задачи через оба пути, холодный и тёплый кэш: живой бюджет исчерпан, а заглушка кэш не моделирует.
- Настоящая сигнатура лимита подписки Max/Team (тело ответа 429 от Anthropic) — в заглушке только два синтетических варианта.
- Память (`MEMORY.md`, `/learn`, `skill_manage`) через ACP с живой моделью — ради них всё и затевалось.
- Какой запрос `claude` шлёт напрямую на `api.anthropic.com` помимо relay (виден только TLS-поток) и тарифицируется ли он.

## 6. Второй проход — пробелы судьи

| Пробел | Итог | Решающая строка |
|---|---|---|
| K2-ratelimit | закрыт | 429 → `end_turn` без `usage`, «rate-limited every one of 3 attempts», 3 запроса к заглушке с паузами 2,8 и 4,6 с, `error_type=RuntimeError`; 529 → 5 циклов, ответа нет > 240 с (`stub-k2-summary.json`) |
| K2-rule-false-positives | закрыт | без `usage` кончаются и `/help`, и пустой промпт, и промпт в идущий ход («Redirected the active turn…»); в строках провала только `thread=acp-agent_0`, id сессии нет (`stub-k2c-summary.json`) |
| K4-crash | закрыт | `sig: "SIGKILL"` в обоих случаях; после SIGKILL посреди хода реплей — 1 `user_message_chunk`, в следующем запросе `SLEEP-INTERRUPTED-MARK: true`, `sleep 20: false`; `pwd` — во втором cwd (`stub-k4-summary.json`) |
| K4-probe-metric | закрыт | `respAt` снимается в `handle()` при разборе строки ответа; в `stub-k4` реплей 2 из 2 и 1 из 1 — до ответа |
| K5-like-for-like | частично | объём и число запросов измерены на одной задаче (0,39× по байтам, ≈0,55× в токенах, 7 против 5 запросов); доллары и кэш — нет, живого бюджета не осталось |
| K5-usage-granularity | закрыт | `usage` — счётчик сессии: A 1000/2000, B 50000/100000 вперемешку; после load A снова 1000 |
| delegate-delivery | закрыт: не работает | простой 30 с — 0 обновлений; следующий ход, рестарт и настоящая сессия первого прохода — ответа ребёнка в запросе нет; `delivery_state: pending`, попыток 0 |
| S6-egress-completeness | закрыт | `nettop` по всей системе ловит отвязанные процессы (`tirith`); relay игнорирует `HTTPS_PROXY`; `HTTP_PROXY` ломает ход; DNS — 1.1.1.1/8.8.8.8 по маршруту по умолчанию (`utun10`) |
| K1-coverage | закрыт | боевой конфиг: `rm -rf`, `find -delete`, `python -c rmtree` под гейтом; `rm файл`, `mv`, `truncate` — нет; `dont_ask` всё равно спрашивает; `accept_edits` пишет без спроса; `allow_always` пишет `command_allowlist` в конфиг |
| probe-timing-skew | закрыт (оценка) | сэмпл egress блокирует цикл событий на 53 мс (медиана) — 128 мс (макс.); лаг таймера p99 111 мс против 4,8 мс без сэмплера. Тайминги первого прохода — ±0,13 с, вердиктов не меняет |
| unverified-claims | закрыт | `claude auth status --json` → `subscriptionType: "team"` (`stub-auth-summary.json`) |
