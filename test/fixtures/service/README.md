# Образцы ответов менеджеров служб

`launchctl print gui/<uid>/<label>` — формат человекочитаемый и не документирован Apple. Разборщик
(`src/service/manager.ts`, `parseLaunchctlPrint`) берёт из него только строки ВЕРХНЕГО уровня блока
службы (во вложенных `resource coalition = {…}` свои `state = active`): `state`, `pid`, `runs`,
`last exit code`, `last terminating signal`.

ПРОИСХОЖДЕНИЕ. Записано лидом 23.09.2026 на macOS (`/bin/launchctl`, служба `dev.pult.acc` приёмки
В4, uid 502). Обезличен только домашний путь (`/Users/<имя>` → `/Users/user`), остальное — байт в байт.

- `launchctl-print-running.txt` — служба работает: `pid` есть, `last exit code = (never exited)`
  (НЕ `0`, как утверждал прежний синтетический образец);
- `launchctl-print-after-kill.txt` — после `kill -9` демона: `state = spawn scheduled`, строки `pid` нет,
  строки `last exit code` НЕТ вовсе — вместо неё `last terminating signal = Killed: 9`;
- `launchctl-missing.txt` — `print`, `bootout` и `kickstart` незагруженной метки: тексты и коды
  (113 / 3 / 113). У `print` первая строка — `Bad request.`.

ПРОИЗВОДНЫЙ (не записан): `launchctl-print-exited-78.txt` — `launchctl-print-after-kill.txt`, где строка
сигнала заменена на `last exit code = 78: EX_CONFIG`. Настоящий выход лаунчера с кодом 78 не снимался;
образец держит проверку «служба указывает на несуществующий node или точку входа». Снимет владелец по
`docs/HUMAN-STEPS-F1-M4.md` — заменить файл на снятый и прогнать `npm test`.

Фальшивый `test/fakes/fake-launchctl.mjs` печатает `print` в том же формате.
