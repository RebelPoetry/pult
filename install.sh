#!/bin/sh
# install.sh — установщик Пульта (docs/08-PLAN-F1-M4.md §5). POSIX sh, без башизмов.
#
#   sh install.sh --from <pult-x.y.z.tgz | https://…/pult-x.y.z.tgz> [--home DIR] [--bin-dir DIR] [--no-service]
#
# Последний релиз (M8c: install.sh и pult.tgz лежат в каждом релизе GitHub, pult.tgz — постоянное имя):
#   curl -q --proto '=https' -fsSLO https://github.com/pawellazarew/pult/releases/latest/download/install.sh
#   sh install.sh --from https://github.com/pawellazarew/pult/releases/latest/download/pult.tgz
# Дальше версии приходят сами: `pult update` проверяет подписанный latest.json того же релиза.
#
# Что он делает — по шагам, чтобы его можно было прочитать до запуска:
#   1. ищет системный node >= 22 в PATH;
#   2. берёт тарбол: локальный путь как есть, URL — только https, `curl -q --proto '=https' -fsSL` во временный файл;
#   3. распаковывает тарбол во временный каталог; системного node нет (или он старше 22) — ставит СВОЙ
#      node Пульта по пину `package/runtime.env` из тарбола: официальный тарбол nodejs.org (или
#      PULT_NODE_MIRROR, только https), sha256 сверяется с пином ДО распаковки, раскладка — как у
#      `pult update` (src/update/runtime.ts): PULT_HOME/runtime/node-v<версия>-<платформа>. Указатель
#      PULT_HOME/runtime/active пишет сам `pult update` (запомнив прежний для отката); установщик — только
#      если версия «уже стоит», а указателя нет или он мёртвый;
#   4. запускает ИЗ распаковки `<node> package/dist/cli/main.js update --from <tgz>` — у пакета нет
#      рантайм-зависимостей, он работает прямо из распаковки, и вся логика установки (версии, проба,
#      откат) живёт в одном месте — в `pult update`, а не дублируется здесь;
#   5. кладёт симлинк <bin-dir>/pult -> PULT_HOME/bin/pult (по умолчанию ~/.local/bin): лаунчер
#      команды (service/pult) сам находит свой node Пульта, системный node команде не нужен. Это
#      ЕДИНСТВЕННАЯ запись вне PULT_HOME (инвариант 8), и существующий НЕ-симлинк не трогается;
#   6. ставит службу (`pult daemon install`), если нет --no-service;
#   7. показывает `pult doctor --no-net`.
#
# Чего он НЕ делает: не трогает sudo, не правит ~/.zshrc и PATH (только подсказывает), не ставит
# node в систему — свой node Пульта живёт только в PULT_HOME/runtime.
# Код выхода: 0 — установлено; 1 — ошибка (текст объясняет, что именно и что делать).
#
# Переменные: PULT_HOME; PULT_NODE_MIRROR — зеркало nodejs.org (только https). В тестах (PULT_TEST=1)
# сеть за node не трогается никогда: тарбол node берётся из PULT_TEST_NODE_TARBALL.

set -eu

MIN_NODE=22

say()  { printf '%s\n' "$*"; }
die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Установка Пульта (pult + демон pultd).

  sh install.sh --from <pult-x.y.z.tgz | URL> [--home DIR] [--bin-dir DIR] [--no-service]

  --from       тарбол пакета: путь к файлу или https-адрес
  --home       куда ставить (PULT_HOME); по умолчанию $PULT_HOME или ~/.pult
  --bin-dir    куда положить симлинк pult; по умолчанию ~/.local/bin
  --no-service не ставить службу (демон будет подниматься по требованию)

Системный node не обязателен: без node >= 22 в PATH установщик ставит свой node Пульта
(официальный, с nodejs.org, сумма сверяется с пакетом) в PULT_HOME/runtime.
EOF
}

FROM=''
HOME_DIR=''
BIN_DIR=''
SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --from)       [ $# -ge 2 ] || die '--from: нужен путь или адрес тарбола'; FROM=$2; shift 2 ;;
    --from=*)     FROM=${1#--from=}; shift ;;
    --home)       [ $# -ge 2 ] || die '--home: нужен каталог'; HOME_DIR=$2; shift 2 ;;
    --home=*)     HOME_DIR=${1#--home=}; shift ;;
    --bin-dir)    [ $# -ge 2 ] || die '--bin-dir: нужен каталог'; BIN_DIR=$2; shift 2 ;;
    --bin-dir=*)  BIN_DIR=${1#--bin-dir=}; shift ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            usage >&2; die "неизвестный аргумент: $1" ;;
  esac
done

[ -n "$FROM" ] || { usage >&2; die 'нужен --from'; }

# Абсолютный путь: симлинк в bin-dir и путь для `pult update` не должны зависеть от того,
# из какой папки запустили установщик.
abs() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)  printf '%s/%s' "$(pwd)" "$1" ;;
  esac
}

PULT_HOME=$(abs "${HOME_DIR:-${PULT_HOME:-$HOME/.pult}}")
BIN_DIR=$(abs "${BIN_DIR:-$HOME/.local/bin}")
export PULT_HOME

node_hint() {
  printf 'install.sh: %s\n' "$1" >&2
  printf '  поставь node >= %s: brew install node   (или nvm: nvm install %s && nvm use %s)\n' "$MIN_NODE" "$MIN_NODE" "$MIN_NODE" >&2
  exit 1
}

# ---- 1. системный node >= 22 -------------------------------------------------
# Нет его — не ошибка: шаг 3 поставит свой node Пульта. Старый node в PATH просто не берётся.
NODE=''
NODE_WHY='node не найден в PATH'
if command -v node >/dev/null 2>&1; then
  # NODE_OPTIONS человека (--require и т.п.) пробе версии не нужен и может её сломать.
  NODE_V=$(NODE_OPTIONS='' node -v 2>/dev/null || true)
  case "$NODE_V" in
    v[0-9]*)
      NODE_MAJOR=${NODE_V#v}
      NODE_MAJOR=${NODE_MAJOR%%.*}
      if [ "$NODE_MAJOR" -ge "$MIN_NODE" ] 2>/dev/null; then
        NODE=$(command -v node)
      else
        NODE_WHY="системный node $NODE_V старше $MIN_NODE"
      fi
      ;;
    *) NODE_WHY="node -v ответил «$NODE_V» — это не node" ;;
  esac
fi

# ---- 2. тарбол ---------------------------------------------------------------
TMP=$(mktemp -d "${TMPDIR:-/tmp}/pult-install.XXXXXX")
# Недоразложенный node (`runtime/<имя>.partial-<pid>`) при обрыве убирается вместе с TMP;
# не успел — его уберёт уборка `pult update` (src/update/runtime.ts → pruneRuntimes).
WORK=''
cleanup() {
  rm -rf "${TMP:?}"
  if [ -n "$WORK" ]; then rm -rf "${WORK:?}"; fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Только https, и curl не пускается никуда, кроме https (`--proto '=https'` — ни сам адрес, ни
# редирект на http://): тарбол дальше ИСПОЛНЯЕТСЯ (`node …/dist/cli/main.js update`), и раньше
# `http://` — или опечатка без `s` — отдавал его подмене по дороге.
case "$FROM" in
  https://*)
    command -v curl >/dev/null 2>&1 || die 'для скачивания нужен curl (или скачай тарбол сам и передай путь)'
    TGZ="$TMP/pult.tgz"
    say "скачиваю $FROM"
    # -q первым: ~/.curlrc человека (прокси без https, --insecure) сюда не подмешивается.
    curl -q --proto '=https' --tlsv1.2 -fsSL "$FROM" -o "$TGZ" || die "не скачался: $FROM"
    ;;
  http://*|*://*)
    die "только https: тарбол по $FROM можно подменить по дороге, а установщик его исполняет. Нужен https-адрес или локальный файл"
    ;;
  *)
    [ -f "$FROM" ] || die "нет файла: $FROM"
    TGZ=$(abs "$FROM")
    ;;
esac

# ---- 3. распаковка и свой node, если системного нет ----------------------------
mkdir "$TMP/x"
tar -xzf "$TGZ" -C "$TMP/x" || die "не распаковался: $TGZ"
ENTRY="$TMP/x/package/dist/cli/main.js"
[ -f "$ENTRY" ] || die "в тарболе нет package/dist/cli/main.js — это не пакет pult"
PIN="$TMP/x/package/runtime.env"

# Пин runtime.env — так же строго, как parsePin в src/update/runtime.ts: строки KEY=VALUE после обрезки
# пробелов, `#` — комментарий, строка без `=` (или с `=` первым) — ошибка; версия — ровно x.y.z; сумма
# любой известной платформы — ровно 64 hex (кривая — ошибка, тихо поставить не тот node хуже);
# незнакомые ключи пропускаются; повтор ключа — побеждает последний. Читает: PIN_VER, PIN_SHA (для $1).
parse_pin() {
  PIN_VER=''
  PIN_SHA=''
  _ln=0
  while IFS= read -r _line || [ -n "$_line" ]; do
    _ln=$((_ln + 1))
    _line=$(printf '%s' "$_line" | LC_ALL=C sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    case "$_line" in ''|'#'*) continue ;; esac
    case "$_line" in
      [!=]*=*) ;;
      *) die "runtime.env:$_ln: не KEY=VALUE — «$_line»" ;;
    esac
    _k=${_line%%=*}
    _v=${_line#*=}
    case "$_k" in
      PULT_NODE_VERSION)
        printf '%s\n' "$_v" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
          || die "runtime.env:$_ln: версия node «$_v» — не x.y.z"
        PIN_VER=$_v
        ;;
      PULT_NODE_SHA256_DARWIN_ARM64|PULT_NODE_SHA256_DARWIN_X64|PULT_NODE_SHA256_LINUX_X64|PULT_NODE_SHA256_LINUX_ARM64)
        printf '%s\n' "$_v" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' \
          || die "runtime.env:$_ln: sha256 в $_k — не 64 hex-символа"
        if [ "$_k" = "PULT_NODE_SHA256_$1" ]; then PIN_SHA=$_v; fi
        ;;
    esac
  done < "$PIN"
  [ -n "$PIN_VER" ] || die 'runtime.env: нет PULT_NODE_VERSION'
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1          # macOS
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1              # Linux (coreutils)
  else
    die 'нет ни shasum, ни sha256sum — сумму node проверить нечем, не ставлю'
  fi
}

# Свой node Пульта — та же раскладка, что у `pult update` (src/update/runtime.ts): тарбол сверяется
# с суммой из пина ДО распаковки (суммы приходят в пакете Пульта, а не с того же адреса, что тарбол),
# распаковка в `<имя>.partial-<pid>`, на место — mv; include/ и share/ вырезаются. Указатель
# runtime/active здесь НЕ пишется: его пишет `pult update` (ensureRuntime находит разложенный node),
# запомнив прежний указатель для отката. Уже лежащий node не запускается и не перекачивается.
# Читает OWN_NODE — путь к bin/node.
lay_out_own_node() {
  [ -f "$PIN" ] || node_hint "$NODE_WHY, а в пакете нет runtime.env (версия старше 0.2.18) — свой node не поставить"
  # Пакет без лаунчера команды (0.2.18–0.2.21): поставить node можно, но команда `pult` у него —
  # npm-ссылка с `#!/usr/bin/env node`, и без системного node она не запустится. Отказ ДО установки.
  [ -f "$TMP/x/package/service/pult" ] \
    || node_hint "$NODE_WHY, а у этого пакета команде pult нужен системный node (лаунчер service/pult — с 0.2.22); возьми пакет новее"
  case "$(uname -s)" in
    Darwin)
      _plat=darwin
      # Архитектура железа, а не процесса: шелл под Rosetta отвечает `uname -m` = x86_64 и на Apple Silicon.
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then _arch=arm64; else _arch=x64; fi
      ;;
    Linux)
      _plat=linux
      case "$(uname -m)" in
        arm64|aarch64) _arch=arm64 ;;
        x86_64|amd64)  _arch=x64 ;;
        *) node_hint "$NODE_WHY, а своего node под $(uname -m) у Пульта нет" ;;
      esac
      # Официальный node с nodejs.org собран под glibc; на musl (Alpine) он не запустится.
      for _musl in /lib/ld-musl-*; do
        if [ -e "$_musl" ]; then node_hint "$NODE_WHY, а здесь musl (Alpine): официальный node nodejs.org под него не собран — поставь node из пакетов системы (apk add nodejs)"; fi
      done
      ;;
    *) node_hint "$NODE_WHY, а своего node под $(uname -s) у Пульта нет" ;;
  esac
  _key=$(printf '%s_%s' "$_plat" "$_arch" | LC_ALL=C tr '[:lower:]' '[:upper:]')
  parse_pin "$_key"
  _ver=$PIN_VER
  _sha=$PIN_SHA
  [ -n "$_sha" ] || node_hint "$NODE_WHY, а в runtime.env нет суммы для $_plat-$_arch"

  _name="node-v$_ver-$_plat-$_arch"
  _rt="$PULT_HOME/runtime"
  _dir="$_rt/$_name"
  OWN_NODE="$_dir/bin/node"
  (umask 077 && mkdir -p "$_rt") || die "не создать $_rt"
  chmod 700 "$PULT_HOME" "$_rt" 2>/dev/null || true

  if [ -f "$OWN_NODE" ] && [ -x "$OWN_NODE" ]; then
    say "свой node $_ver уже лежит: $_dir"
    return 0
  fi
  say "$NODE_WHY — ставлю свой node Пульта $_ver в $_rt"
  _tgz="$TMP/$_name.tar.gz"
  if [ "${PULT_TEST:-}" = 1 ]; then
    # Тесты: сеть не трогается никогда (тот же шов, что в runtime.ts).
    [ -n "${PULT_TEST_NODE_TARBALL:-}" ] || die 'PULT_TEST=1: сеть в тестах не трогается — нужен PULT_TEST_NODE_TARBALL'
    cp "$PULT_TEST_NODE_TARBALL" "$_tgz" || die "нет файла $PULT_TEST_NODE_TARBALL"
    _src=$PULT_TEST_NODE_TARBALL
  else
    # Как mirrorOf в runtime.ts: обрезать пробелы и хвостовые `/`, только https.
    _mirror=$(printf '%s' "${PULT_NODE_MIRROR:-}" | LC_ALL=C sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s:/*$::')
    _mirror=${_mirror:-https://nodejs.org/dist}
    case "$_mirror" in
      https://*) ;;
      *) die "PULT_NODE_MIRROR=$_mirror: только https — node по нему можно подменить по дороге" ;;
    esac
    command -v curl >/dev/null 2>&1 || node_hint "$NODE_WHY, а скачать свой node нечем: нужен curl"
    _src="$_mirror/v$_ver/$_name.tar.gz"
    say "скачиваю $_src"
    curl -q --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 20 "$_src" -o "$_tgz" || die "не скачался: $_src"
  fi
  _got=$(sha256_of "$_tgz")
  [ "$_got" = "$_sha" ] || die "$_src: sha256 $_got не совпадает с runtime.env ($_sha) — тарбол битый или подменён, не ставлю"
  WORK="$_rt/$_name.partial-$$"
  rm -rf "${WORK:?}"
  mkdir "$WORK" || die "не создать $WORK"
  tar -xzf "$_tgz" -C "$WORK" || die "$_src не распаковался"
  _xdir="$WORK/$_name"
  say 'проверяю node: первый запуск свежего бинаря macOS проверяет до минуты'
  _said=''
  if [ -f "$_xdir/bin/node" ] && [ -x "$_xdir/bin/node" ]; then _said=$(NODE_OPTIONS='' "$_xdir/bin/node" -v 2>/dev/null || true); fi
  [ "$_said" = "v$_ver" ] || die "в $_src нет $_name/bin/node v$_ver (ответил: ${_said:-ничего})"
  # Заголовки C и man-страницы Пульту не нужны (~64 МБ из ~200); bin/ и lib/ (npm) остаются.
  rm -rf "${_xdir:?}/include" "${_xdir:?}/share"
  if [ -f "$OWN_NODE" ] && [ -x "$OWN_NODE" ]; then
    # Соседняя установка успела раньше: её node на месте и, может быть, уже работает — свою копию выбрасываем.
    say "свой node $_ver уже положила другая установка: $_dir"
  elif [ -e "$_dir" ]; then
    # Каталог есть, а исполняемого node в нём нет — на нём ничего не живёт; mv не заменяет каталог.
    mv "$_dir" "$_dir~old-$$" || die "не отодвинуть $_dir"
    mv "$_xdir" "$_dir" || die "не положить node в $_dir"
    rm -rf "${_dir:?}~old-$$"
  else
    mv "$_xdir" "$_dir" || die "не положить node в $_dir"
  fi
  rm -rf "${WORK:?}"
  WORK=''
}

OWN_NODE=''
if [ -z "$NODE" ]; then
  lay_out_own_node
  NODE=$OWN_NODE
fi

# ---- 4. `pult update --from` из распаковки ------------------------------------
say "ставлю в $PULT_HOME"
if ! "$NODE" "$ENTRY" update --from "$TGZ"; then
  die "установка не удалась (текст выше). PULT_HOME: $PULT_HOME"
fi
[ -e "$PULT_HOME/current" ] || die "после установки нет $PULT_HOME/current"

# Указатель своего node пишет `pult update` (ensureRuntime). Но «уже стоит» до своего node не доходит:
# повтор установки той же версии на машине без node оставил бы команду без него. Тогда — только если
# указателя нет или он ведёт в никуда; живой указатель (на другой node) не трогаем.
if [ -n "$OWN_NODE" ]; then
  _act="$PULT_HOME/runtime/active"
  _cur=''
  if [ -r "$_act" ]; then IFS= read -r _cur < "$_act" || true; fi
  if [ -z "$_cur" ] || [ ! -f "$_cur" ] || [ ! -x "$_cur" ]; then
    _ptr="$PULT_HOME/runtime/active.tmp-$$"
    (umask 077 && printf '%s\n' "$OWN_NODE" > "$_ptr") && mv -f "$_ptr" "$_act" \
      || die "не записать указатель $_act"
  fi
fi

# ---- 5. симлинк в bin-dir ----------------------------------------------------
# Лаунчер команды (service/pult) есть в пакетах с 0.2.22; у пакета старше — прежняя цель
# current/bin/pult (npm-ссылка на dist/cli/main.js с `#!/usr/bin/env node`: ей нужен системный node).
TARGET="$PULT_HOME/bin/pult"
if [ ! -f "$TARGET" ] || [ ! -x "$TARGET" ]; then
  [ -z "$OWN_NODE" ] || die "после установки нет лаунчера $TARGET, а системного node нет — команде pult не на чем работать"
  TARGET="$PULT_HOME/current/bin/pult"
fi
[ -e "$TARGET" ] || die "после установки нет ни $PULT_HOME/bin/pult, ни $PULT_HOME/current/bin/pult"
LINK="$BIN_DIR/pult"
mkdir -p "$BIN_DIR"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  die "$LINK уже есть и это не симлинк — не трогаю; убери его или передай --bin-dir"
fi
ln -sfn "$TARGET" "$LINK"
say "pult: $LINK -> $TARGET"

case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) say "подсказка: $BIN_DIR нет в PATH — добавь в ~/.zshrc (или ~/.profile): export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
if [ "$PULT_HOME" != "$HOME/.pult" ]; then
  say "подсказка: PULT_HOME не по умолчанию — добавь в ~/.zshrc: export PULT_HOME=\"$PULT_HOME\""
fi

# ---- 6. служба ---------------------------------------------------------------
if [ "$SERVICE" = 1 ]; then
  if [ "$(uname -s)" = Darwin ]; then
    say 'macOS: служба запускает node. Когда агент впервые заработает в папке внутри ~/Desktop, ~/Documents'
    say 'или ~/Downloads, macOS спросит «“node” would like to access files…» — нажми «Разрешить».'
  fi
  "$LINK" daemon install || die "служба не встала (текст выше); pult уже установлен — повтори: $LINK daemon install"
else
  say 'служба не ставится (--no-service): демон поднимается первой командой; поставить позже — pult daemon install'
fi

# ---- 7. доктор ---------------------------------------------------------------
# Его «fail» (например, не найден claude) установку не отменяет: это про машину, а не про Пульт.
"$LINK" doctor --no-net || say 'pult doctor нашёл, что поправить (выше); сам Пульт установлен'

# Команда обязана ответить: «готово» при неработающем `pult` хуже явной ошибки.
VERSION_SAID=$("$LINK" --version) || die "$LINK --version не ответил — команда pult не работает (текст выше)"
say "готово: $VERSION_SAID"
