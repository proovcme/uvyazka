# RVT в составе Увязки

`rvt-rs/` — выбранные исходники rvt-rs 0.4.0, commit
`120e2f9ffa8422ba437102c8d300b7e902cdde80`, Apache-2.0.
Сохранены [LICENSE](rvt-rs/LICENSE) и [NOTICE](rvt-rs/NOTICE).
Происхождение и SHA-256 каждого включённого файла —
[UVYAZKA-SOURCE.json](rvt-rs/UVYAZKA-SOURCE.json); перед сборкой хеши проверяются
с нормализацией CRLF → LF. Исходники конвертера не изменены.

Включены библиотека, CLI, необходимые данные компиляции и workspace-члены
Python/WASM. Корпус RVT/RFA/IFC, чужая Git-история, окружения и готовые
исполняемые файлы не включены. Полный набор upstream-тестов здесь не поставляется;
для него используйте исходный репозиторий.

`rvt-metadata-reader/` перенесён из авторского IFCCS: ограниченное чтение
сохранённых стадий, параметров, видов и спецификаций через тот же декодер.
Добавлен режим `--extract INPUT.rvt REQUEST.json OUTPUT`: каталог классов
и текущие нативные записи с покрытием и диагностикой. Это собственное
дополнение; исходники rvt-rs не менялись. [Работа с данными](../docs/RVT_DATA.md). Имя
исполняемого файла ifccs-rvt-metadata сохранено для совместимости.

`rvt-browser-bridge/` — дополнение Увязки: ввод байтов, сохранённые сетки,
диагностика, запрет выдачи пустого IFC при отсутствии геометрии. Его WASM
ещё не подключён к публичному демо. [План](../docs/BROWSER_SIMULATION_PLAN.md).

## Сборка и проверка

Из корня checkout Увязки, с Rust >=1.87 и системными C/C++ build tools:

```powershell
uv run python tools/setup_rvt.py
uv run uvyazka rvt-status
```

Сборка использует Cargo.lock, устанавливает четыре бинарника в локальное
состояние Увязки и атомарно выбирает готовую версию. Существующие версии
сохраняются. Хеши бинарников проверяются при использовании. Ключи API,
Revit и каталог прежнего IFCCS не нужны. Если задан UVYAZKA_HOME, используйте
то же значение при сборке и при запуске MCP. Также есть wrapper tools/setup_rvt.ps1.

Для синтетической проверки конвертера:

```powershell
uv run python tools/setup_rvt.py --with-fixture-generator
uv run python tools/check_rvt_runtime.py
```

Установки из wheel могут использовать уже собранный runtime или явный
UVYAZKA_RVT_BIN_DIR. Для сборки из исходников нужен checkout или sdist;
Rust-исходники не дублируются в Python wheel.

Для проверки WASM-моста:

```powershell
rustup target add wasm32-unknown-unknown
cargo check --locked --manifest-path integrations/rvt-browser-bridge/Cargo.toml --target wasm32-unknown-unknown
```

Это проверка компиляции; работоспособность браузерного загрузчика проверяется
отдельно, после его подключения. Все зависимости сохраняют собственные лицензии.
