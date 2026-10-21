# Спайк Hermes через ACP — как повторить

Вопрос: может ли Hermes Agent (Nous Research) стать провайдером №4 Пульта через ACP
(`hermes acp`, JSON-RPC по stdio). Вердикт и разбор — [`docs/09-DELTA-hermes-spike.md`](../../docs/09-DELTA-hermes-spike.md).
Замер 26.09.2026: hermes-agent 0.21.5, плагин `claude-subscription-directsdk` 0.3.0, Claude Code 2.1.282, macOS, VPN в режиме TUN.

## Что здесь лежит

| Файл | Что это |
|---|---|
| `acp-probe.mjs` | Зонд первого прохода (живые ходы): шаги `s1 s2 s3 s4 s5 s7 s8 delegate`, плюс `redact` и `clean` |
| `stub-probe.mjs` | Зонд второго прохода — ноль вызовов модели: `setup k2 k2c usage k4 delegate k1 k5 review proxy adopt ghsuppress sampler auth` |
| `lab/sitecustomize.py` | Переводит соединение relay плагина с `api.anthropic.com` на локальную заглушку и пишет `set_tunnel` (только под `PYTHONPATH=$LAB/stubpy`) |
| `lab/claude-fixture.sh` | Настоящий `claude` с ключом-фикстурой и пустым `CLAUDE_CONFIG_DIR` — вход владельца отсюда недоступен |
| `lab/k1_battery.py` | Офлайн-батарея: какие разрушительные команды ловит `tools/approval_detection.py` |
| `logs/*.jsonl` | Транскрипты ACP по шагам (каждая строка — кадр `in`/`out`, строка stderr или итог хода), уже после редакции |
| `logs/*-summary.json` | Итог шага в одном JSON: то, на что опирается DELTA |
| `logs/egress.jsonl` | Сэмплы `lsof` по дереву процессов во время каждого хода (S6) |
| `logs/exit-checks.jsonl` | Все проверки страны выхода перед шагами |

## Лаборатория (всё вне репозитория — только здесь)

```sh
LAB=$HOME/.pult-lab/hermes
mkdir -p $LAB/{home,repos,tmp,uv-cache}
export UV_CACHE_DIR=$LAB/uv-cache

# 1. venv на Python 3.13 (у 0.21.5 requires-python >=3.11,<3.14)
uv venv --python 3.13 $LAB/venv

# 2. hermes-agent 0.21.5 = тег v2026.9.24 = коммит f97608f178d1ffeca59860195ab7da295f7c8e5f.
#    На PyPI последняя версия 0.19.0, а сборку колеса из git Hermes запрещает
#    («Building wheels or sdists for hermes-agent is not supported»), поэтому — клон и editable.
git clone --filter=blob:none https://github.com/NousResearch/hermes-agent $LAB/src
git -C $LAB/src checkout f97608f178d1ffeca59860195ab7da295f7c8e5f
uv pip install --python $LAB/venv/bin/python -e "$LAB/src[acp]"   # без [acp] `hermes acp --check` падает: No module named 'acp'

# 3. Обёртка окружения: белый список Пульта + лабораторные переменные
cat > $LAB/henv.sh <<'EOF'
#!/bin/sh
L=$HOME/.pult-lab/hermes
exec env -i HOME="$HOME" USER="$USER" PATH="$L/venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm}" TMPDIR="$L/tmp" HERMES_HOME="$L/home" \
  HERMES_ACP_SKIP_CONFIGURED_MCP=1 UV_CACHE_DIR="$L/uv-cache" "$@"
EOF
chmod +x $LAB/henv.sh
$LAB/henv.sh hermes acp --version     # 0.21.5
$LAB/henv.sh hermes acp --check       # Hermes ACP check OK

# 4. Плагин подписки Claude — из каталога Hermes, закреплённый по коммиту
$LAB/henv.sh hermes plugins install claude-subscription-directsdk \
  --ref 72dfaa4556b74f31faf8658d665e1d615e1be62d --enable
```

5. Конфиг `$HERMES_HOME/config.yaml` (здесь `HERMES_HOME=$LAB/home`) — к тому, что записал установщик плагина, добавить:

```yaml
model:
  provider: claude-subscription-directsdk-experimental
  default: haiku
fallback_providers: []
approvals:
  mode: manual        # никогда smart: он сам зовёт вспомогательную LLM и сам одобряет
  timeout: 3600       # таймаут держит брокер Пульта, а не Hermes (по умолчанию 300 с)
skills:
  write_approval: true
memory:
  write_approval: true
  nudge_interval: 0
terminal:
  backend: local      # docker/modal/… пропускают проверку опасных команд целиком
curator:
  enabled: false
auxiliary:            # без этого Hermes тратит лишние вызовы модели на заголовки и «саморазбор»
  background_review: {enabled: false}
  title_generation: {enabled: false, model_upgrade_enabled: false}
```

Этот конфиг первого прохода **небезопасен**: по умолчанию Hermes читает вход Claude Code из Keychain и ходит с ним
на `api.anthropic.com/v1/models`, а токен GitHub берёт через `gh` из каталогов Homebrew (DELTA §3). При повторе обязательно добавить:

```yaml
security:
  tirith_enabled: false
auth:
  adopt_external_logins: false   # не читать Keychain, ~/.claude/.credentials.json, ~/.codex/auth.json
```

в `$HERMES_HOME/auth.json` — `"suppressed_sources": {"copilot": ["gh_cli", "env:COPILOT_GITHUB_TOKEN", "env:GH_TOKEN", "env:GITHUB_TOKEN"]}`,
в окружение ребёнка — `HERMES_DISABLE_LAZY_INSTALLS=1`, `UV_CACHE_DIR`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` под `$LAB`,
и никаких `HTTP_PROXY`/`HTTPS_PROXY` без `NO_PROXY=127.0.0.1,localhost`.

## Прогон

Нужны: собранный пакет (`npm ci && npx tsc -p .` — зонд берёт `buildChildEnv` и `buildClaudeArgv` из `dist/`),
залогиненный терминальный `claude`, VPN, который даёт известную не-RU страну выхода.

```sh
node spike/hermes/acp-probe.mjs s1        # initialize, возможности, версия, session/new; egress старта
node spike/hermes/acp-probe.mjs s2        # «Reply OK» во временном git-репо — виды событий, usage, первый кусок текста
node spike/hermes/acp-probe.mjs s3        # гейт: ls, запись файла, rm -rf ./junk (deny, затем allow_once)
node spike/hermes/acp-probe.mjs s4        # session/cancel при висящем разрешении и посреди хода
node spike/hermes/acp-probe.mjs s5        # убить ребёнка → новый → session/load старой сессии s3 + ход; bogus id
node spike/hermes/acp-probe.mjs s7        # CLAUDE_CONFIG_DIR=пустая папка: как выглядит «не залогинен»
node spike/hermes/acp-probe.mjs delegate  # delegate_task: как ребёнок виден в ACP
node spike/hermes/acp-probe.mjs s8        # тот же крошечный ход через путь claude самого Пульта (база цены)
node spike/hermes/acp-probe.mjs redact    # $LAB/raw → spike/hermes/logs с заменой путей, почты, токенов
git ls-files --others --exclude-standard spike/hermes | node scripts/ci-leakguard.mjs
```

Страховки в самом зонде: перед каждым шагом с моделью — `curl …/cdn-cgi/trace`, страна RU или неизвестна → STOP;
бюджет — 12 промптов через Hermes и 3 через `claude` Пульта (`$LAB/budget.json`); ребёнок живёт в своей группе процессов
и убивается вместе с деревом; в конце печатаются выжившие процессы, если они есть. Сырые транскрипты — только в `$LAB/raw`.

## Второй проход — без модели

Бюджет живых ходов кончился, поэтому пробелы судьи закрыты на заглушке Messages API. Работают настоящие `hermes acp`, плагин и `claude`,
но relay плагина отправляет свой единственный запрос не в Anthropic, а в заглушку внутри зонда. Заглушка отвечает по метке `[[…]]`
в реплике пользователя (текст, вызов инструмента, 429/529) и пишет размер и состав каждого запроса в `logs/stub-<шаг>-upstream.jsonl`.
Значения заголовков не пишутся. Запрос с `authorization` (OAuth) заглушка не обслуживает и считает нарушением (`stubViolations`).

```sh
node spike/hermes/stub-probe.mjs setup      # $LAB/stubpy, копии HERMES_HOME: home-stub (боевой конфиг) и home-stub-lab (конфиг 1-го прохода)
node spike/hermes/stub-probe.mjs k2         # 429 (API и «подписочный»), 529: что видно в ACP и stderr
node spike/hermes/stub-probe.mjs k2c        # 4 сессии в одном процессе: провал, /help, промпт в идущий ход, пустой промпт
node spike/hermes/stub-probe.mjs usage      # usage — счётчик сессии или процесса; после session/load
node spike/hermes/stub-probe.mjs k4         # SIGKILL между ходами и посреди `sleep 20`, load с другим cwd
node spike/hermes/stub-probe.mjs delegate   # доставка ответа фонового ребёнка: простой 30 с, следующий ход, рестарт
node spike/hermes/stub-probe.mjs k1         # гейт в боевом конфиге: эквиваленты rm -rf, режимы, allow_always (портит config.yaml копии!)
node spike/hermes/stub-probe.mjs setup && node spike/hermes/stub-probe.mjs k5   # одна задача из 3 ходов: Hermes ×2 конфига и claude Пульта
node spike/hermes/stub-probe.mjs review     # цена фонового разбора памяти и скиллов (nudge_interval: 1)
node spike/hermes/stub-probe.mjs proxy      # HTTPS_PROXY/HTTP_PROXY: кто идёт через прокси, а кто мимо; nettop по всей системе
node spike/hermes/stub-probe.mjs adopt      # auth.adopt_external_logins: false — нет запроса /v1/models с чужим OAuth
node spike/hermes/stub-probe.mjs ghsuppress # suppressed_sources.copilot — нет обмена токена GitHub
node spike/hermes/stub-probe.mjs sampler    # сколько сэмплер egress первого зонда блокирует цикл событий
node spike/hermes/stub-probe.mjs auth       # claude auth status: только loggedIn/authMethod/subscriptionType и имена полей
$LAB/henv.sh $LAB/venv/bin/python spike/hermes/lab/k1_battery.py
node spike/hermes/acp-probe.mjs redact
```

Страна выхода проверяется и здесь, хотя до модели ничего не доходит: Hermes сам ходит в интернет (каталоги, GitHub).
Внимание: шаги `k5` (конфиг первого прохода) и `review` запускают Hermes без `adopt_external_logins: false`, и он читает вход Claude Code.
Заглушка такой запрос отвергает, но само чтение Keychain происходит. Не повторять без нужды.

Уборка — удалить `$HOME/.pult-lab/hermes`. Плюс то, что Hermes 0.21.5 написал мимо `HERMES_HOME` (DELTA §4):
`~/.local/share/tirith`, `~/.local/state/tirith` и записи в `~/.cache/uv`.
