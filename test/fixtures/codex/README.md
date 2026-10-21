# Фикстуры Codex — сырой протокол `codex app-server`

Что это. Каждый `*.jsonl` — **дословные сообщения провода** (по одному JSON-RPC-сообщению в
строке), как их прислал настоящий `codex app-server`. Рядом `*.timing.json` — смещения в
миллисекундах по строкам: по ним `test/fakes/fake-codex-app-server.mjs` отыгрывает поток с
настоящим ритмом (делитель `speed` в `.pult-fake-codex.json`).

- CLI: **codex-cli 0.155.0-alpha.9.2** (`~/.local/bin/codex` → внутрь ChatGPT.app).
- Слепок схемы протокола на эту версию:
  `116bdc390b1bbc4d9ec82f5423ac70600089d3ab710932719cc578e889e0d2bb` (310 файлов),
  сверяется в `src/adapters/codex/schema.ts` и в `pult doctor`.
- 28.09.2026 слепок в `schema.ts` переснят на **codex-cli 0.158.0-alpha.2.1**
  (`da52a92a5dff90a80801f3469cf59f2fc55930ed99554cc3f0f167da788484d1`, 314 файлов). Фикстуры НЕ
  перезаписывались: сверка `scripts/diff-codex-schema.mjs` показала, что всё, что адаптер читает
  и шлёт, в 0.158 байт в байт прежнее (DELTA v0.4 §2а). Строка выше про 310 файлов — история.
- В CI ничего из этого не записывается и настоящий `codex` не запускается никогда.

## Откуда взята каждая

| Файл | Источник | Настоящий? | Что внутри |
|------|----------|-----------|------------|
| `01-simple-turn.jsonl` | прогон спайка `b1`, 20.09.2026 | да | ход целиком: `turn/started`, `item/*` (`userMessage`, `agentMessage` + дельта `OK`), `thread/tokenUsage/updated`, `account/rateLimits/updated`, `turn/completed`. Оставлен и ШУМ записи (`mcpServer/startupStatus/updated`, `hook/*`, `account/updated`, `thread/status/changed`) — так поток выглядел до того, как Пульт научился гасить его через `optOutNotificationMethods` |
| `02-permission-decline.jsonl` | прогон спайка `b2-decline`, 20.09.2026 | да | запрос сервера `item/commandExecution/requestApproval` со всеми 12 полями и `availableDecisions: ["accept", {acceptWithExecpolicyAmendment…}, "cancel"]`; ответ `decline` → `commandExecution` со `status: "declined"`, ход всё равно `completed` |
| `03-permission-accept.jsonl` | прогон спайка `b2-accept`, 20.09.2026 | да | то же, но `accept` → `exitCode: 0` |
| `04-subagent.jsonl` | прогон спайка `b4`, 20.09.2026 | да | родитель и ребёнок в ОДНОМ соединении: `subAgentActivity` (`started` с `agentPath: "/root/ping"`, затем `completed` с ДРУГИМ id), `collabAgentToolCall` (`tool: "wait"`), `agentMessage` ребёнка `PING`, ответ родителя `Subagent reply: PING`. Ребёнок объявляет себя `thread/status/changed` ДО `subAgentActivity` — эта строка законно выбрасывается |
| `05-error-retry-storm.jsonl` | прогон спайка `s5-appserver`, 20.09.2026 | да | мёртвый прокси: уведомления `error` с `willRetry: true` и текстом `Reconnecting... 2/5`, `codexErrorInfo.responseStreamDisconnected`, `warning` про откат с WebSocket на HTTPS. `turn/completed` не приходит вовсе |
| `06-resume-turn.jsonl` | прогон спайка `b3`, 20.09.2026 | да | ход после `thread/resume` (сервер убит SIGKILL, разговор поднят заново) |
| `07-rate-limits-read-limited.json` | проба В3, 21.09.2026 | да | ответ `account/rateLimits/read` при **исчерпанном лимите**: `ordinaryUsageAllowed: false`, `rateLimitReachedType: "rate_limit_reached"`, `primary.usedPercent: 100`, `rateLimitUpsell`. **Редакция:** `accountId` и `rateLimitResetCredits[].id` заменены на `<redacted>` |
| `08-usage-limit-error.jsonl` | СИНТЕТИКА с измеренным текстом | частично | конверт `error`/`turn/completed` собран руками, а **текст и `codexErrorInfo` — настоящие**: они взяты из записи `~/.codex/sessions/…/rollout-*.jsonl` того самого хода, который 21.09.2026 упёрся в лимит (`codex_error_info: "usage_limit_exceeded"`, в протоколе app-server то же значение в camelCase). Почему синтетика: снять живое уведомление можно только начав ход, а лимит держится до 22.09 |
| `09-handshake-and-control.jsonl` | проба В3, 21.09.2026 | да | ОБЕ стороны провода: `initialize` с `optOutNotificationMethods` и ответ; `thread/start` и его ответ; `thread/resume` треда без ходов → `-32600 no rollout found for thread id …`; `turn/interrupt` без хода → `-32600 no active turn to interrupt`; `thread/unsubscribe` → `unsubscribed`, повторный → `notSubscribed`. Пути `cwd` — временная папка пробы |
| `10-rate-limits-sparse.jsonl` | 1-я и 6-я строки настоящие, 2–5 синтетика | частично | слияние разреженных снимков: полный снимок (из b1), потом только `primary`, потом только `secondary` без длительности окна, потом достижение лимита, потом снятие `rateLimitReachedType: null`. Последняя строка — **измеренная** форма «оба окна `null` при исчерпанном лимите» (запись `token_count` из rollout 21.09.2026). Синтетика нужна потому, что все снимки спайка оказались полными: разреженность описана схемой, но в записи не встретилась |
| `11-approval-params-0.163.json` | живой codex-cli 0.163.0-alpha.10.2, 19.10.2026 (независимое ревью M8d) | да | `params` двух запросов разрешения как пришли: команда в сеть из песочницы (`proposedExecpolicyAmendment` + объект `acceptWithExecpolicyAmendment` в `availableDecisions`, БЕЗ `acceptForSession` и `decline`, без `proposedNetworkPolicyAmendments`) и правка файла вне папки (`{threadId, turnId, itemId, startedAtMs, reason: null, grantRoot: null}` — `availableDecisions` нет). **Редакция:** `cwd` — заглушка временной папки |

## Живое измерение 22.09.2026 (лид, после сброса лимита)

Запрос разрешения вызывается записью ВНЕ рабочей папки (`echo hi > $HOME/<файл>` при
`sandbox: workspace-write` + `approvalPolicy: on-request`); команда внутри песочницы не
спрашивает ничего. На живом сервере пришло `"availableDecisions":["accept","cancel"]` —
**`decline` не предложен**, `reason` локализован на русский. Правило адаптера «отказ — всегда
`decline`» подтвердилось: сервер его принял, элемент закрылся `{isError:true,
status:"declined"}`, ход продолжился и закончился успешно, файл не создан. Отдельной фикстурой
это не записано: форма сообщения совпадает с 02/03, отличаются только состав
`availableDecisions` и язык `reason`.

## Чем важны 07, 09 и 10

Они отвечают на три вопроса, без которых адаптер писался бы наугад:

1. **Когда тред возобновляем.** `09` показывает: `thread/start` возвращает `thread.path`, но
   файла по этому пути нет, и свежий сервер отвечает `no rollout found for thread id`.
   Значит `providerSessionId` попадает в реестр только по первому `turn/started`, а строка
   ошибки — сигнал самолечения (`NO_ROLLOUT_RE`).
2. **Как выглядит исчерпанный лимит.** `07` — машинные признаки (`ordinaryUsageAllowed`,
   `rateLimitReachedType`), а не английский текст.
3. **Что значит `null` в снимке лимитов.** `10`: у `rateLimitReachedType` это СНЯТИЕ лимита,
   а у окон — «в этом сообщении цифр нет». Перепутать их значит либо навсегда оставить
   сессию `limited`, либо показать прочерк вместо процентов.

## Как перезаписать под новую версию CLI

```sh
npm run build
node scripts/record-codex-fixtures.mjs          # 01–06, 09: настоящие потоки, ~6 крошечных ходов
node scripts/record-codex-fixtures.mjs --probe  # только 07 и 09: БЕЗ единого хода модели
```

Рекордеру нужны залогиненный `codex`, сеть и квота; страж страны выхода — тот же код, что у
адаптера. Версию CLI и слепок схемы в шапке обновить руками
(`codex --version`, `node scripts/record-codex-fixtures.mjs --schema`).
