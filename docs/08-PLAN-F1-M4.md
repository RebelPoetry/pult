# Ф1 В4 — служба, обновление, worktree (решения лида, 23.09.2026)

Основание: `04-DELTA-v0.3.md` §2 и §5 (модель поставки), `05-DELTA-v0.4-spike.md` §4 (окружение и служба, измерено спайком S9),
`07-PLAN-F1.md` (протокол, инварианты, веха В4). Код спайка `spike/env/{service/*,update.mjs,test-launch.mjs,test-update.mjs}` переносится, а не пишется заново;
спайк остаётся доказательством и продуктовым кодом не импортируется.

Приёмка вехи (из плана): служба ставится и снимается; откат проверен на двух версиях; `--worktree` создаёт ветку и папку одной командой.
Перезагрузка и системный диалог доступа к `~/Desktop` — руками владельца по `docs/HUMAN-STEPS-F1-M4.md` (пишет сборщик).

## 1. Раскладка `PULT_HOME` — что добавляется
```
versions/<v>/            установленная версия: npm --global --prefix → bin/pult, bin/pultd, lib/node_modules/pult/…
versions/<v>.partial/    установка в процессе; до переименования версией НЕ считается
current -> versions/<v>  симлинк активной версии; переключается ТОЛЬКО symlink(tmp) + rename(tmp, current)
bin/pultd-launch         лаунчер службы (копия из активной версии пакета, 0755)
node-path                файл состояния лаунчера: путь к node ≥ 22
update.json              история обновлений: current, previous, bad[], последняя попытка
worktrees/<repo>/<имя>   рабочие папки агентов, заведённых с --worktree
logs/service.log         stdout+stderr процесса под launchd/systemd (строки лаунчера, падения до журнала)
run/update.lock          один `pult update` за раз (O_CREAT|O_EXCL + живость pid, как pultd.lock)
```
`logs/pultd.log` остаётся журналом самого демона (JSONL). Служба пишет в `service.log`, а НЕ в `pultd.log`: иначе в одном файле
перемешаются JSONL демона и сырой текст лаунчера, а `pult daemon logs` перестанет разбираться. Размер `service.log` ограничен
(лаунчер обрезает файл больше 5 МБ перед `exec` — launchd держит его открытым с O_APPEND, поэтому обрезка безопасна, а переименование — нет).

## 2. Служба: `pult daemon install | uninstall`
Модуль `src/service/`. Платформа — `process.platform`: `darwin` → launchd, `linux` → `systemd --user`, иначе ошибка «не поддерживается».

**Швы для тестов** (только при `PULT_TEST=1`, в бою игнорируются — как `PULT_TEST_NET` в В3): `PULT_SERVICE_PLATFORM` (darwin|linux),
`PULT_LAUNCHCTL`, `PULT_SYSTEMCTL`, `PULT_LOGINCTL` (путь к фальшивому бинарю, пишущему argv в лог), `PULT_SERVICE_DIR` (куда класть файл службы).
В бою бинари берутся по абсолютным системным путям (`/bin/launchctl`, `/usr/bin/systemctl`, `/usr/bin/loginctl`), не из PATH.
Настоящий `launchctl`/`systemctl` в тестах и CI не вызывается НИКОГДА (раннер macOS — не место для загрузки служб).

**Имя службы**: по умолчанию метка `dev.pult.daemon` (launchd) и юнит `pultd.service` (systemd). `PULT_SERVICE_NAME` (разрешён и в бою)
задаёт другое имя — для второго `PULT_HOME` и для приёмки лида, которая не должна задеть будущую настоящую службу.

**Точка входа службы** — всегда `PULT_HOME/bin/pultd-launch`. Лаунчер ищет демона так: `$PULT_ENTRY`, иначе
`$PULT_HOME/current/lib/node_modules/pult/dist/daemon/main.js` (установленная версия), иначе `$PULT_HOME/current/dist/daemon/main.js`
(рабочая копия, см. `--dev`). Так `pult update`, переключив `current`, меняет код службы без перезаписи plist/юнита.

**install** (идемпотентен, повтор перезаписывает и перезагружает):
1. Нужна активная версия: `current` существует. Нет — отказ с подсказкой: `pult update --from <tgz>` или `pult daemon install --dev`.
   `--dev` связывает РАБОЧУЮ КОПИЮ пакета, из которой запущен CLI, как версию: `versions/<version>-dev` → симлинк на корень пакета, `current` → на неё.
   Если корень пакета лежит в `~/Desktop`, `~/Documents` или `~/Downloads` на macOS — предупреждение: служба вызовет системный диалог доступа для `node`.
2. `PULT_HOME/bin/pultd-launch` ← копия из активной версии (0755, tmp+rename). `node-path` ← `process.execPath` (первая попытка лаунчера сразу удачна).
3. Работающий демон «по требованию» останавливается мягко (`daemon.stop`, ожидание снятия lock) — иначе служебный экземпляр упрётся в lock.
4. Файл службы пишется атомарно (tmp+rename). Все подставляемые строки экранируются (XML в plist; кавычки и `%` в юните).
   - plist: `Label`; `ProgramArguments` = [лаунчер]; `RunAtLoad` true; `KeepAlive {SuccessfulExit: false}`; `ThrottleInterval` 10;
     `StandardOutPath`/`StandardErrorPath` → `logs/service.log`; `WorkingDirectory` = HOME; `ProcessType` Standard (было Background — снято 30.09.2026, см. §10);
     `EnvironmentVariables`: `PATH` (каталог текущего node + `/opt/homebrew/bin` + `~/.local/bin` + `/usr/local/bin` + `/usr/bin:/bin:/usr/sbin:/sbin`, без дублей),
     `PULT_HOME` (абсолютный), `PULT_SERVICE=1`. Режим файла 0644 (launchd отвергает group/world-writable).
   - юнит: как `spike/env/service/pultd.service`, но с абсолютным `PULT_HOME` вместо `%h/.pult`; `StartLimitIntervalSec`/`StartLimitBurst` в `[Unit]`;
     `Restart=on-failure`; вывод `append:` в `logs/service.log`; `Environment=` для PATH, PULT_HOME, PULT_SERVICE=1.
5. Загрузка: macOS — `launchctl bootout gui/<uid>/<label>` (ошибку «не загружена» игнорировать) и `launchctl bootstrap gui/<uid> <plist>`;
   Linux — `systemctl --user daemon-reload`, `systemctl --user enable --now <unit>`, затем `loginctl show-user <user> -p Linger`; не `yes` —
   `loginctl enable-linger <user>`; не вышло — предупреждение с ТОЧНОЙ командой, установка при этом успешна.
6. Проверка: сокет отвечает `hello_ok` с версией активной версии за ≤ 15 с. Нет — код 1, хвост `service.log` и статус менеджера служб;
   служба остаётся установленной, печатается команда `pult daemon uninstall`.
`--print` печатает файл службы и команды загрузки, ничего не записывая (им же CI проверяет сгенерированные файлы).

**uninstall** (идемпотентен; службы нет → код 0 «службы нет»): macOS — `bootout`, удалить plist; Linux — `disable --now`, удалить юнит, `daemon-reload`.
Linger не трогается (на нём могут жить чужие службы) — строка-напоминание. `PULT_HOME` не удаляется.

**Запуск по требованию при установленной службе** (`ensureDaemon`): если файл службы есть — `launchctl kickstart gui/<uid>/<label>`
(без `-k`; служба не загружена — `launchctl bootstrap`, см. §10) / `systemctl --user start <unit>` и ожидание сокета; отсоединённый спавн — только если менеджер служб ответил ошибкой (с предупреждением).
Иначе появляются два демона, второй выходит с кодом 3, и launchd перезапускает его каждые 10 с.
Код 3 при занятом lock остаётся: под launchd это самовосстановление (служба заберёт демона, когда чужой экземпляр уйдёт),
под systemd — остановка после `StartLimitBurst`, которую видит `pult doctor`. Записать это в README.

**Остановка**: `pult daemon stop` под службой — демон выходит с кодом 0, launchd (`SuccessfulExit: false`) и systemd (`on-failure`)
его НЕ поднимают; следующая команда поднимет через менеджер служб. SIGTERM от `bootout`/`systemctl stop` — чистый выход с кодом 0 (проверить тестом).

**`pult daemon status`** добавляет строку службы: установлена (файл есть и указывает на существующий лаунчер) / загружена / pid / последний код выхода;
режим демона: `service` или `on-demand`.

## 3. Лаунчер `service/pultd-launch`
POSIX sh в КОРНЕ пакета (`service/`), попадает в тарбол: `package.json` → `files: ["dist", "service"]`; тест проверяет, что `npm pack` кладёт
его с битом исполнения. Перенос `spike/env/service/pultd-launch` с правками: порядок поиска точки входа из §2; обрезка `service.log`;
код 78 на ошибки конфигурации (нет node ≥ 22, нет точки входа); `PULT_DRY_RUN=1`. Тесты — перенос `spike/env/test-launch.mjs` в `test/`
(случаи: нет файла состояния, битый путь, не исполняемый, v18 < 22, пустой PATH, обе раскладки точки входа, код 78).

## 4. Обновление: `pult update`
> **M8c (0.2.27, 19.10.2026):** VPS из черновика Ф7 заменён релизами GitHub — подписанный Ed25519 `latest.json`
> (конверт одним файлом), голый `pult update` и `--check`, проверка демоном раз в сутки, «Обновить» в окне.
> Формат, ключи и модель угроз — `docs/DEV.md`, раздел «M8c: канал обновлений». Ниже — решения В4 как были.

Источника на VPS ещё нет (Ф7). В В4:
- `pult update --from <файл.tgz>` — поставить тарбол и переключиться;
- `pult update --to <версия>` — переключиться на уже стоящую версию (ручной откат);
- `pult update --list` — версии на диске, current, previous, пометки bad;
- `pult update` без аргументов — код 1 и текст «источник обновлений (latest.json) появится в Ф7; сейчас --from или --to». `update` уходит из `LATER_VERBS`.

**Шаги `--from`**: `run/update.lock` → версия и имя из `package/package.json` внутри тарбола (`tar -xzOf`), имя обязано быть `pult` →
если `versions/<v>` уже активна — код 0 «уже стоит»; есть, но не активна — переключение без переустановки (`--reinstall` переставит) →
`npm install --global --prefix versions/<v>.partial --offline --no-audit --no-fund --loglevel warn <tgz>` с окружением по белому списку
(`HOME=PULT_HOME` — чужой `~/.npmrc` не читается; `npm_config_cache=PULT_HOME/npm-cache`; PATH с каталогом node), npm — сосед `process.execPath`,
иначе `locateTool('npm')` → проверка: есть `bin/pultd`, `lib/node_modules/pult/dist/daemon/main.js`, `node <новый cli> --version` = v →
`rename(.partial, <v>)` → лаунчер из новой версии в `PULT_HOME/bin` → запомнить previous → переключить `current` → перезапуск и проба (ниже).

**Перезапуск и проба.** CLI, выполняющий обновление, — СТАРАЯ версия: демона новой версии он поднимает из `current/…/dist/daemon/main.js`,
а не из своего `../daemon/main.js` (эту ловушку проверить тестом). Демон работал — `daemon.stop` (сессии остаются в реестре и поднимаются ленивым resume,
как в В2/В3); служба установлена — `launchctl bootout` + `bootstrap` (та же загрузка, что у `daemon install`) / `systemctl --user restart`; иначе отсоединённый спавн новой точки входа.
Проба — до трёх попыток: `hello_ok` за ≤ 10 с, `daemon.status.version` = v, демон жив через 2 с после ответа (ловит падение сразу после `listen`).
**Решение лида 23.09.2026** (замер на настоящем launchd: `kickstart -k` после падения придержан ThrottleInterval на 10–18,6 с за вызов, откат шёл 65 с;
`bootout` + `bootstrap` до ответа сокета — 1,5 с): под launchd каждый перезапуск `pult update` (попытки и откат) — перезагрузка, не `kickstart -k`,
а процесс, вышедший до `hello_ok`, кончает пробу сразу без новых попыток — повторяются только таймаут без выхода и «ответил, но через 2 с мёртв».
Демона до обновления не было и службы нет — после удачной пробы он останавливается (состояние как было).
**Откат**: проба провалилась → `current` назад на previous, лаунчер из previous, старый демон поднимается снова, версия помечается `bad` в `update.json`,
её папка остаётся на диске; код 1, в тексте — «откат на <previous>» и хвост stderr/журнала новой версии. Первой установке откатываться некуда: `current` снимается, код 1.
**Хранение**: после удачи остаются current, previous и ещё одна последняя; `bad` удаляются первыми; current и previous не удаляются никогда.

## 5. `install.sh` (черновик Ф7, в корне репо)
> **M8c:** install.sh и `pult.tgz` (постоянное имя) едут в каждом релизе GitHub; установка последнего —
> `sh install.sh --from https://github.com/pawellazarew/pult/releases/latest/download/pult.tgz`.

POSIX sh, читаемый другом до запуска. `sh install.sh --from <tgz|URL> [--home DIR] [--bin-dir DIR] [--no-service]`:
проверка node ≥ 22 (нет — подсказка `brew install node` / nvm, код 1) → тарбол (локальный путь или `curl -fsSL` во временный файл) →
распаковка во временный каталог и запуск ИЗ НЕГО `node package/dist/cli/main.js update --from <tgz>` (пакет без рантайм-зависимостей работает из распаковки;
вся логика установки — одна, в `pult update`) → симлинк `<bin-dir>/pult` → `PULT_HOME/current/bin/pult` (по умолчанию `~/.local/bin`; нет в PATH — подсказка) →
`pult daemon install`, если нет `--no-service` (на macOS — предупреждение про диалог доступа к `~/Desktop`) → `pult doctor --no-net`.
Тест в CI: временный HOME, локальный тарбол, `--no-service` и отдельно — со службой на фальшивом менеджере служб.

## 6. `pult agent start … --worktree <ветка>`
- `cwd` обязан быть внутри git-репозитория (`git -C <cwd> rev-parse --show-toplevel`), иначе `invalid_params`.
- Ветка проверяется `git check-ref-format --branch`; имя папки — ветка с `/` → `-` и только `[A-Za-z0-9._-]`.
- Папка: `PULT_HOME/worktrees/<basename(toplevel)>-<первые 8 hex sha256(realpath(toplevel))>/<папка>` — вне репозитория (не пачкает его `git status`,
  как это делает `.claude/worktrees/`), внутри `PULT_HOME` (инвариант 8).
- Папка есть и это worktree того же репо на той же ветке → переиспользовать (агента можно удалить и завести заново). Ветка есть и нигде не выписана →
  `git worktree add <папка> <ветка>`. Ветки нет → `git worktree add -b <ветка> <папка> <base>`, база — `--base <ref>` или HEAD `cwd`.
  Ветка выписана в другом месте → ошибка с этим путём. Никакого `--force` нигде.
- `cwd` сессии = папка worktree + тот же относительный подкаталог, что был у `cwd` внутри репо.
- Git — с окружением по белому списку (инвариант 1) и `GIT_TERMINAL_PROMPT=0`. Делает это демон в `agent.start`.
- Реестр хранит `worktree: {path, branch, repo}`; `agent list` и `agent read` его показывают.
- `pult agent rm <имя>` worktree НЕ трогает и печатает его путь. `pult agent rm <имя> --worktree` вдобавок делает `git worktree remove <папка>` БЕЗ `--force`:
  грязное дерево → отказ всей команды (код 1, текст git), сессия не удаляется. Ветка не удаляется никогда (в ней может быть неотправленная работа).

## 7. `pult doctor` — новые пункты
служба установлена/загружена/последний код выхода (78 → «служба указывает на несуществующий node или точку входа»); файл службы указывает на существующий лаунчер;
`node-path` жив; на Linux включён linger; `current` указывает на существующую версию и её версия; версия работающего демона ≠ `current` → «перезапусти демона».

## 8. Инвариант 8 — уточнение формулировки
Запись разрешена: в `PULT_HOME`; в рабочую папку сессии и её worktree; в `.git` исходного репозитория (служебные файлы `git worktree`);
в файл службы (`~/Library/LaunchAgents/<label>.plist` или `~/.config/systemd/user/<unit>`) — ТОЛЬКО по явной команде `pult daemon install|uninstall`;
в `<bin-dir>/pult` — только `install.sh`. Всё остальное — нарушение, закреплённое тестом.

## 9. CI и тесты
- Раздел C `ci-check.sh` проверяет СГЕНЕРИРОВАННЫЕ файлы (`pult daemon install --print` на обе платформы через `PULT_SERVICE_PLATFORM`), а не только спайковые:
  `plutil -lint` на macOS, `systemd-analyze verify --user` на Linux с ЧТЕНИЕМ вывода (на неизвестную директиву он выходит с 0).
- Обновление тестируется НАСТОЯЩИМ npm на настоящих тарболах: `npm pack` из временной копии пакета (package.json с подменённой версией + `dist` + `service`)
  даёт версии A и B и сломанную C (`dist/daemon/main.js` выходит с кодом 1); сценарий A→B удачно, B→C с откатом на B (демон B снова отвечает, C помечена bad и лежит на диске),
  `--to A`, `--list`, хранение. Только `--offline`, сеть не нужна. Каждый поднятый демон гасится в `finally`; сирот нет.
- Все тесты — `PULT_TEST=1`, временный `PULT_HOME`, фальшивые менеджеры служб. Состояние фейков из лог-файлов проверяется только после `waitFor`.
  Вопросы брокера в тестах не оставлять неотвеченными (ref-нутый таймер на 10 минут держит прогон).

## 10. Поправки по замеру на настоящем launchd (30.09.2026)
Повод: на машине владельца демон под службой стартовал 11 с (напрямую — 0,4 с), `pult update` не дождался `hello_ok`, получил
`Bootstrap failed: 5: Input/output error`, поднял демона напрямую и оставил службу незагруженной; после открытия окна демон минуту
не отвечал на `hello`. Воспроизведено на отдельной службе (`PULT_SERVICE_NAME`, временный `PULT_HOME`), цифры — в `DEV.md`.

- **`ProcessType` — `Standard`, не `Background`** (заменяет §2 п.4). `Background` — фоновый класс launchd (ресурсы процесса
  ограничены, чтобы фоновая работа не мешала человеку), и его наследует всё, что запускает демон: `claude`, `codex`, `git`. Один и тот же набор запусков (граф модулей,
  семь `--version`, логин-шелл, два входа): 22,8 с под `Background` против 1,3 с под `Standard` и 1,2 с под `Interactive`.
  Берётся `Standard`: разницы с `Interactive` замер не показал. Файл службы `pult update` не переписывает (инвариант 8), поэтому
  установленной службе нужен повторный `pult daemon install` — об этом говорят `pult doctor` (пункт «Файл службы») и сам `pult update`.
- **До `listen` демон не запускает ни одного процесса, кроме `ps` для lock.** Путь к `claude`/`codex` ищется по файловой системе
  (`locateToolPath`), версия старту не нужна. Раньше `locateTool` спрашивал `--version` у обоих через `spawnSync`.
- **`doctor.run` не держит событийный цикл.** Логин-шелл, `--version`, `claude auth status`, `codex login status` — асинхронные запуски,
  идущие разом (`src/env/exec.ts`); сеть проверяется по провайдерам разом; второй `doctor.run` посреди первого получает тот же отчёт.
- **Загрузка ждёт конца выгрузки** (дополняет §2 п.5). `launchctl bootout` отвечает сразу, а служба остаётся в launchd, пока её
  процесс не вышел (замер: 1,3–5,1 с — до `exit timeout = 5`); `bootstrap` в это время отвечает кодом 5. `load` опрашивает
  `launchctl print` до «службы нет» (до 15 с) и только потом грузит; не выгрузилась — отказ с причиной. Если за это время
  службу загрузила другая команда (у неё новый pid, либо наш `bootstrap` получил «уже загружена») — это успех, а не отказ.
- **`ensureDaemon`: незагруженную службу грузит `bootstrap`.** `kickstart` по ней отвечает `113: Could not find service` — раньше
  на этом всё кончалось спавном в обход. systemd этого не нужно: `start` читает юнит с диска. Исключение — lock уже держит живой
  демон, поднятый напрямую: поверх него служба не грузится (её процесс выходил бы с кодом 3 каждые 10 с).
- **Демон поднят в обход службы — об этом сказано прямо.** `pult update` и любая команда через `ensureDaemon` печатают, загружена ли
  служба, и команду возврата: `pult daemon install`. Код выхода `pult update` остаётся 0: версия переключена и проверена.
