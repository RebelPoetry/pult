# S9g — шаги, которые может сделать только владелец

Агент службу launchd **не загружал** (правило спайка). Здесь — точные команды, чтобы проверить руками
три вещи, которые без загруженной службы и без живого человека проверить нельзя:

1. демон под launchd поднимается и переживает выход из сессии;
2. macOS показывает системный диалог **«node» would like to access files in your Desktop folder**
   (TCC, «Файлы и папки») — и к чему именно он привязывается;
3. демон возвращается после перезагрузки.

Всё внутри `spike/env/`. В конце — команда, которая убирает службу полностью.

---

## 0. Что уже проверено без тебя

| Что | Где доказательство |
|-----|--------------------|
| `plutil -lint` на plist → `OK`, 12 проверок ключей прошли | `validate-service.log.jsonl` |
| `pultd-launch` сам чинит путь к node (нет файла / битый путь / не исполняемый / v18 < 22) | `test-launch.log.jsonl` |
| Логин-шелл отдаёт PATH за ~120 мс, прокси-переменных в нём **нет вообще** | `capture-env.log.jsonl` |
| `claude`, `codex`, `opencode`, `gh`, `node`, `npm` **не видны** в PATH launchd-агента | `locate-cli.log.jsonl` |

Поэтому в plist прописан `EnvironmentVariables.PATH` с `/opt/homebrew/bin` и `~/.local/bin` — без него
`pultd-launch` не нашёл бы даже `node`.

---

## 1. Загрузить службу

```sh
cd ~/src/pult/spike/env

# 1.1 Проверить, что plist валиден (должно напечатать: ... : OK)
plutil -lint service/dev.pult.daemon.plist

# 1.2 Положить рядом настоящую точку входа демона, иначе pultd-launch выйдет с кодом 78.
#     Для проверки TCC годится заглушка, которая читает ~/Desktop и пишет в лог.
mkdir -p fakehome/.pult service/logs
cat > fakehome/.pult/entry.mjs <<'EOF'
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const line = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
line({ ev: 'started', pid: process.pid, node: process.version, PATH: process.env.PATH });
try {
  const names = readdirSync(join(homedir(), 'Desktop'));
  line({ ev: 'desktop_read_ok', count: names.length });
} catch (e) {
  line({ ev: 'desktop_read_failed', code: e.code, message: e.message });
}
setInterval(() => line({ ev: 'tick' }), 30000);
EOF

# 1.3 Скопировать plist туда, где launchd его ищет
mkdir -p ~/Library/LaunchAgents
cp service/dev.pult.daemon.plist ~/Library/LaunchAgents/dev.pult.daemon.plist

# 1.4 Загрузить (современная форма; НЕ launchctl load)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.pult.daemon.plist
```

Если `bootstrap` ругается `Bootstrap failed: 5: Input/output error` — служба уже загружена;
сначала сделай `launchctl bootout` из раздела 4, потом повтори.

## 2. Проверить, что она жива

```sh
# Статус: PID и код последнего выхода
launchctl print gui/$(id -u)/dev.pult.daemon | sed -n '1,25p'

# Короче: третья колонка — Label, первая — PID, вторая — последний код выхода
launchctl list | grep dev.pult.daemon

# Наш лог (сюда идут и stdout, и stderr: см. StandardOutPath/StandardErrorPath)
tail -f ~/src/pult/spike/env/service/logs/pultd.log
```

Ждём в логе:
- `pultd-launch: ... resolved via ...` и `exec /opt/homebrew/bin/node ...` — лаунчер нашёл node;
- `{"ev":"started", ... "PATH": "/opt/homebrew/bin:..."}` — переменные из plist доехали;
- дальше — **или** `desktop_read_ok`, **или** `desktop_read_failed` с `code` (скорее всего `EPERM`).

## 3. Диалог доступа к ~/Desktop (главное, ради чего это делается)

Диалог **«node» would like to access files in your Desktop folder** появляется один раз,
в момент первого чтения `~/Desktop` из-под launchd. Что записать:

1. **Появился ли он вообще.** Может не появиться, если `node` уже разрешён раньше — проверь
   Системные настройки → Конфиденциальность и безопасность → **Файлы и папки**, и есть ли там `node`.
2. **На чьё имя.** В диалоге и в списке — «node», не «Pult» и не «Terminal».
   Это и есть проблема: разрешение цепляется к бинарю `/opt/homebrew/bin/node`, общему для всего на маке.
3. **Что будет, если нажать «Не разрешать».** В логе должно появиться
   `{"ev":"desktop_read_failed","code":"EPERM", ...}`. Запиши точный `code` и `message`.
4. **Если диалога нет, а чтение упало** — значит запрос подавлен (так бывает у фоновых агентов без
   интерфейса). Тогда единственный путь — выдать доступ вручную: Файлы и папки → перетащить
   `/opt/homebrew/bin/node`, либо дать **Full Disk Access**. Запиши, какой вариант сработал.

Сбросить решение для повторной проверки (спросит пароль, это штатная команда tccutil):

```sh
tccutil reset SystemPolicyDesktopFolder
```

После сброса: `launchctl kickstart -k gui/$(id -u)/dev.pult.daemon` — перезапустит демон и вызовет диалог снова.

## 4. Тест на перезагрузку

```sh
# До перезагрузки — запомни PID
launchctl list | grep dev.pult.daemon
sudo shutdown -r now      # обычная перезагрузка
```

После входа в систему, **не открывая терминал специально**, подожди минуту и проверь:

```sh
launchctl list | grep dev.pult.daemon        # PID должен быть НОВЫЙ и не пустой
grep -c '"ev":"started"' ~/src/pult/spike/env/service/logs/pultd.log
```

Записать: поднялся ли сам (`RunAtLoad`), и нужен ли был повторный диалог TCC после перезагрузки.

Проверка `KeepAlive {SuccessfulExit: false}` — убить демон и посмотреть, что launchd его вернул:

```sh
kill -9 $(launchctl list | awk '/dev.pult.daemon/{print $1}')
sleep 12 && launchctl list | grep dev.pult.daemon    # PID должен смениться
```

`ThrottleInterval` = 10 с, поэтому ждать надо больше десяти секунд.

## 5. Убрать всё

```sh
launchctl bootout gui/$(id -u)/dev.pult.daemon
rm -f ~/Library/LaunchAgents/dev.pult.daemon.plist
launchctl list | grep dev.pult.daemon || echo "службы нет — чисто"
pgrep -fl 'fakehome/.pult/entry.mjs' || echo "процессов нет — чисто"
```

Если хочется убрать и следы TCC: Системные настройки → Конфиденциальность и безопасность →
Файлы и папки → выключить `node`.

---

## Что вернуть в спайк

Четыре строки, больше не нужно:

1. `launchctl list | grep dev.pult.daemon` сразу после bootstrap — PID и код выхода.
2. Решающая строка из `service/logs/pultd.log`: `desktop_read_ok` или `desktop_read_failed` + `code`.
3. Появился ли диалог, на какое имя, и что в списке «Файлы и папки».
4. `launchctl list | grep dev.pult.daemon` после перезагрузки — новый PID или пусто.
