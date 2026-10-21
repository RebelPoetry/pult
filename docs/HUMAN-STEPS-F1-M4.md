# Ф1 В4 — служба руками (шаги владельца)

Агент службу на твоей машине НЕ загружал: настоящий `launchctl` в тестах и при сборке не вызывается никогда,
все тесты идут на фальшивом менеджере служб (`test/fakes/fake-launchctl.mjs`). Здесь — точные команды, чтобы
проверить то, что без живой машины и живого человека не проверить:

1. служба ставится на настоящий `~/.pult` и демон под ней отвечает;
2. `kill -9` — демон возвращается сам примерно через 10 с;
3. перезагрузка — демон поднимается после входа;
4. системный диалог доступа к `~/Desktop` (TCC) — когда появляется и к чему привязан;
5. служба снимается начисто.

Время: ~15 минут плюс одна перезагрузка. В конце — 4 строки, которые надо прислать.

---

## 0. Подготовка

После мёржа вехи В4 в `main`:

```sh
cd ~/src/pult
git switch main && git pull
npm ci && npm run build
alias pult="node $PWD/dist/cli/main.js"     # в этой вкладке терминала
pult --version                              # ожидается 0.1.0 (или текущая версия пакета)
pult daemon install --print | head -40      # посмотреть plist, ничего не записывается
```

Если демон уже работает по требованию — ничего делать не нужно: `install` сам остановит его мягко.

## 1. Поставить службу — выбери ОДИН путь

### 1А. Из рабочей копии (`--dev`) — быстро, но с диалогом TCC

```sh
pult daemon install --dev
echo "код $?"
```

`current` станет ссылкой на эту папку (`~/.pult/versions/0.1.0-dev -> ~/src/pult`).
Папка лежит в `~/Desktop`, поэтому `install` напечатает предупреждение, и при первом старте службы macOS покажет
диалог **«“node” would like to access files in your Desktop folder»**. Нажми **«Разрешить»** (Allow). Если нажать
«Не разрешать» — демон под службой не прочитает свою точку входа, `pult daemon status` покажет код выхода, а
`~/.pult/logs/service.log` — ошибку доступа. Исправить: Системные настройки → Конфиденциальность и безопасность →
Файлы и папки → `node` → включить «Папка „Рабочий стол“», затем `pult daemon install --dev` ещё раз.

Помни: служба теперь исполняет код из этой папки. `git switch` на другую ветку меняет код службы при следующем
её старте.

### 1Б. Из тарбола — без диалога для точки входа

Точка входа окажется в `~/.pult/versions/…`, вне `~/Desktop`:

```sh
npm pack --offline                                   # → pult-0.1.0.tgz в текущей папке
pult update --from ./pult-0.1.0.tgz                  # ставит в ~/.pult/versions/0.1.0 и переключает current
~/.pult/current/bin/pult daemon install
echo "код $?"
rm pult-0.1.0.tgz
```

(То же одной командой, заодно с симлинком `~/.local/bin/pult` и службой: `sh install.sh --from ./pult-0.1.0.tgz`.)

Диалог TCC в этом варианте всё равно появится, но позже — в тот момент, когда агент под службой впервые заработает
в папке внутри `~/Desktop` (`pult agent start … --cwd ~/Desktop/…`). Это ожидаемо: разрешение даётся `node` один раз.

### Что должно получиться

```
служба установлена: /Users/you/Library/LaunchAgents/dev.pult.daemon.plist
демон 0.1.0 отвечает: pid NNNNN, режим service; журнал службы /Users/you/.pult/logs/service.log
```

Код выхода 0. Если код 1 — `install` сам напечатал хвост `service.log` и состояние launchd; служба при этом
остаётся установленной. Пришли этот вывод целиком.

## 2. Проверить, что она жива

```sh
pult daemon status
# ждём: «режим service» и строку «служба: установлена (…) · лаунчер … · загружена · pid NNNNN · …»

launchctl print gui/$(id -u)/dev.pult.daemon | sed -n '1,60p' > /tmp/pult-launchctl-print.txt
grep -E '^\s*(state|pid|runs|last exit code|last terminating signal) = ' /tmp/pult-launchctl-print.txt

tail -n 20 ~/.pult/logs/service.log     # строки pultd-launch: «сохранённый node годен…», «exec …»
pult doctor --no-net | grep -iE 'служб|лаунчер|node для'
```

`/tmp/pult-launchctl-print.txt` — настоящий образец ответа `launchctl print`. Разборщик написан по образцам
`test/fixtures/service/*.txt`, собранным по формату без живого launchd; если строки `state`, `pid`,
`last exit code` у тебя выглядят иначе — приложи файл, образцы заменим.

## 3. `kill -9` — демон возвращается сам

```sh
OLD=$(pult daemon status --json | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).pid))')
kill -9 "$OLD"; date +%T
sleep 12
pult daemon status | head -2; date +%T
```

Ожидается НОВЫЙ pid и «режим service». `kill -9` — ненулевой выход, `KeepAlive.SuccessfulExit=false` поднимает
службу, `ThrottleInterval` 10 с — отсюда пауза. Для сравнения штатная остановка:

```sh
pult daemon stop
sleep 12
launchctl print gui/$(id -u)/dev.pult.daemon | grep -E 'state|last exit code'   # not running, код 0 — НЕ поднялась, так и надо
pult agent list                          # любая команда поднимает демона через launchctl kickstart
pult daemon status | head -2             # снова «режим service»
```

## 4. Перезагрузка

Перезагрузи мак, войди в систему, открой терминал:

```sh
cd ~/src/pult && alias pult="node $PWD/dist/cli/main.js"
pult daemon status | head -2             # аптайм — секунды/минуты с момента входа, «режим service»
```

Заметь, был ли после входа диалог TCC про `node` и что ты нажал.

## 5. Снять службу

```sh
pult daemon uninstall; echo "код $?"
launchctl print gui/$(id -u)/dev.pult.daemon 2>&1 | head -1   # ждём: Could not find service "dev.pult.daemon" …
ls ~/Library/LaunchAgents | grep -i pult                      # пусто
pult daemon uninstall                                         # повтор: «службы нет — снимать нечего», код 0
```

`~/.pult` не удаляется: сессии, журнал и версии остаются. Демон дальше снова поднимается по требованию.
Если нужен и сброс разрешения TCC: `tccutil reset SystemPolicyDesktopFolder` (сбросит его у ВСЕХ приложений —
осторожно).

## Linux (если когда-нибудь понадобится)

То же самое, но `install` кладёт `~/.config/systemd/user/pultd.service`, грузит его
`systemctl --user daemon-reload && systemctl --user enable --now pultd.service` и включает linger. Если linger включить
не дали — `install` печатает `sudo loginctl enable-linger <user>`; без него демон умирает с последней SSH-сессией.
Проверка: `systemctl --user status pultd.service`, `journalctl` не нужен — вывод в `~/.pult/logs/service.log`.

---

## Что прислать (4 строки)

1. **Установка:** путь (1А или 1Б), код выхода `install` и строка «демон … отвечает: pid …, режим service» (или весь вывод при коде 1).
2. **kill -9:** старый pid → новый pid и через сколько секунд вернулся (по двум `date +%T`).
3. **Перезагрузка:** первые две строки `pult daemon status` после входа + был ли диалог TCC про `node`, на что он ссылался
   (Desktop / Documents / Downloads) и что ты нажал.
4. **Снятие:** код `uninstall` и первая строка `launchctl print` после него.

По желанию — файл `/tmp/pult-launchctl-print.txt` из шага 2 (настоящий образец для тестов).
