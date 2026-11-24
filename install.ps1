# Установка LLM Leaders: подключает мод к игре, включает FireTuner, ставит зависимости моста.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$docs = [Environment]::GetFolderPath('MyDocuments')
$civ = Join-Path $docs "My Games\Sid Meier's Civilization VI"
$mods = Join-Path $civ 'Mods'
$target = Join-Path $mods 'LLMLeaders'
$source = Join-Path $root 'mod\LLMLeaders'

Write-Host "== LLM Leaders: установка ==" -ForegroundColor Cyan

# 1. Мод -> папка Mods (через junction, чтобы правки сразу попадали в игру)
if (-not (Test-Path $civ)) { throw "Не найдена папка $civ. Запустите Civilization VI хотя бы один раз." }
New-Item -ItemType Directory -Force $mods | Out-Null
if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType -eq 'Junction') { Write-Host "Мод уже подключён: $target" }
    else { throw "В $target уже есть папка (не ссылка). Удалите её вручную и запустите снова." }
} else {
    New-Item -ItemType Junction -Path $target -Target $source | Out-Null
    Write-Host "Мод подключён: $target -> $source" -ForegroundColor Green
}

# 2. FireTuner. AppOptions.txt обычно лежит в %LOCALAPPDATA%\Firaxis Games\..., у старых установок — в Документах
$opts = @(
    (Join-Path $env:LOCALAPPDATA "Firaxis Games\Sid Meier's Civilization VI\AppOptions.txt"),
    (Join-Path $civ 'AppOptions.txt')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($opts) {
    $text = [IO.File]::ReadAllText($opts)
    if ($text -match '(?m)^\s*EnableTuner\s+1') {
        Write-Host 'FireTuner уже включён.'
    } elseif ($text -match '(?m)^\s*;?\s*EnableTuner\s+\d') {
        Copy-Item $opts "$opts.bak" -Force
        $text = [regex]::Replace($text, '(?m)^\s*;?\s*EnableTuner\s+\d', 'EnableTuner 1')
        [IO.File]::WriteAllText($opts, $text)
        Write-Host 'FireTuner включён (EnableTuner 1). Резервная копия: AppOptions.txt.bak' -ForegroundColor Green
    } else {
        Write-Host 'В AppOptions.txt нет строки EnableTuner — включите в игре: Настройки → Игра → «Tuner».' -ForegroundColor Yellow
    }
} else {
    Write-Host 'AppOptions.txt ещё не создан: запустите игру один раз, закройте её и запустите install.bat снова,' -ForegroundColor Yellow
    Write-Host 'или включите в игре: Настройки → Игра → «Tuner (disables achievements)».' -ForegroundColor Yellow
}

# 3. Зависимости моста
Push-Location (Join-Path $root 'bridge')
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Не найден Node.js (нужна версия 18+): https://nodejs.org' }
    npm install --no-audit --no-fund
    if (-not (Test-Path 'config.yaml')) {
        Copy-Item 'config.example.yaml' 'config.yaml'
        Write-Host 'Создан bridge\config.yaml — впишите туда ключ API и модель.' -ForegroundColor Yellow
    }
} finally { Pop-Location }

Write-Host "`nГотово. Дальше:" -ForegroundColor Cyan
Write-Host ' 1) bridge\config.yaml — ключ API и модель'
Write-Host ' 2) Запустите игру, в «Дополнения» включите LLM Leaders, начните/загрузите партию'
Write-Host ' 3) probe.bat — проверка связи; затем start.bat — запуск моста'
