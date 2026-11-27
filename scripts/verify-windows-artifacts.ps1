param(
    [Parameter(Mandatory = $true)][string]$Installer
)
$ErrorActionPreference = 'Stop'
$app = $null
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('fluid-test-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $root '应用 Space'
$env:SWITCH_HOME = Join-Path $root 'providers'
$env:CODEX_HOME = Join-Path $root 'codex'
$env:CLAUDE_CONFIG_DIR = Join-Path $root 'claude'
$env:SWITCH_CLAUDE_DESKTOP_HOME = Join-Path $root 'desktop'
$env:SWITCH_PORT = '38173'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$state = Join-Path $env:SWITCH_HOME 'state.json'
$receipt = Join-Path $env:SWITCH_HOME 'updates\pending.json'
$file = Join-Path $env:CODEX_HOME 'config.toml'
$exe = Join-Path $install 'fluid.exe'
$original = "# fixture" + [char]10 + 'model="fixture"' + [char]10
$token = 'fixture-loopback-token'
try {
    $setup = Start-Process -FilePath $Installer -ArgumentList "/S /D=$install" -Wait -PassThru
    if ($setup.ExitCode -ne 0 -or !(Test-Path $exe)) { throw 'NSIS installation failed.' }
    New-Item -Force -ItemType Directory (Split-Path $receipt), $env:CODEX_HOME | Out-Null
    [IO.File]::WriteAllText($file, $original)
    @{version = 1; token = $token; active = 'test'; providers = @{test = @{type = 'api'; baseUrl = 'http://127.0.0.1:1/v1'; apiKey = 'fixture'}}} |
        ConvertTo-Json -Depth 8 -Compress | Set-Content -Encoding utf8NoBOM $state
    $preferences = Join-Path $env:SWITCH_HOME 'desktop.json'
    $sync = Join-Path $env:SWITCH_HOME 'sync.json'
    '{"language":"zh-CN","theme":"dark"}' | Set-Content -Encoding utf8NoBOM $preferences
    '{"kind":"ssh","url":"fixture","enabled":false}' | Set-Content -Encoding utf8NoBOM $sync
    $saved = Get-FileHash $state, $preferences, $sync
    @{version = $version; token = 'receipt'; ready = $false; executable = $exe; nativeHelper = $true} |
        ConvertTo-Json -Compress | Set-Content -Encoding utf8NoBOM $receipt
    $setup = Start-Process -FilePath $Installer -ArgumentList "/S --updated /D=$install" -Wait -PassThru
    if ($setup.ExitCode -ne 0 -or !(Test-Path $exe) -or !(Test-Path (Join-Path $install 'uninstall.exe'))) {
        $remaining = (Get-ChildItem -LiteralPath $install -ErrorAction SilentlyContinue).Name -join ', '
        throw "Native NSIS upgrade failed (exit $($setup.ExitCode)). Remaining files $remaining."
    }
    foreach ($fileHash in $saved) {
        if ((Get-FileHash $fileHash.Path).Hash -ne $fileHash.Hash) { throw 'The upgrade changed saved provider data or preferences.' }
    }
    $worker = Join-Path $install 'worker'
    foreach ($resource in 'node.exe', 'desktop/worker.js', 'package.json') {
        if (!(Test-Path (Join-Path $worker $resource))) { throw "Missing installed worker resource $resource." }
    }
    $stderr = Join-Path $root 'startup.stderr'
    $app = Start-Process -FilePath $exe -ArgumentList '--hidden' -WorkingDirectory $install `
        -RedirectStandardError $stderr -RedirectStandardOutput (Join-Path $root 'startup.stdout') -PassThru
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $healthy = $false
    $healthError = ''
    while ($clock.Elapsed.TotalSeconds -lt 30 -and !$app.HasExited) {
        try {
            $data = Get-Content $receipt -Raw | ConvertFrom-Json
            if ($data.ready -and (Test-Path (Join-Path (Split-Path $receipt) 'app-ready.txt'))) {
                $response = Invoke-RestMethod -Uri "http://127.0.0.1:$env:SWITCH_PORT/health" -Headers @{Authorization = "Bearer $token"} -TimeoutSec 2
                $healthy = $response.service -eq 'fluid'
                if ($healthy) { break }
            }
        } catch { $healthError = $_.Exception.Message }
        Start-Sleep -Milliseconds 200
    }
    if (!$healthy -or !(Select-String -Quiet -Path $file -Pattern '^model_provider = "fluid"') -or
        ((Get-Content (Join-Path (Split-Path $receipt) 'app-ready.txt') -Raw) -cne 'receipt')) {
        $confirmation = Get-Content $receipt -Raw | ConvertFrom-Json
        $marker = Test-Path (Join-Path (Split-Path $receipt) 'app-ready.txt')
        $configured = Select-String -Quiet -Path $file -Pattern '^model_provider = "fluid"'
        $app.Refresh()
        $status = if ($app.HasExited) { "exited $($app.ExitCode)" } else { 'running' }
        $details = Get-Content $stderr -Raw -ErrorAction SilentlyContinue
        throw "The installed gateway did not confirm startup ($status, receipt=$($confirmation.ready), marker=$marker, configured=$configured, health=$healthy). $healthError $details"
    }
    Stop-Process -Id $app.Id -Force
    $app.WaitForExit(5000) | Out-Null
    $clock.Restart()
    while ($clock.Elapsed.TotalSeconds -lt 10 -and [IO.File]::ReadAllText($file) -ne $original) { Start-Sleep -Milliseconds 100 }
    if ([IO.File]::ReadAllText($file) -ne $original) { throw 'The installed recovery helper did not restore Codex settings.' }
    $uninstall = Start-Process -FilePath (Join-Path $install 'uninstall.exe') -ArgumentList '/S /DELETEAPPDATA' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0 -or (Test-Path $exe) -or (Test-Path $state)) { throw 'The uninstaller did not remove fluid and its saved data.' }

} finally {
    if ($app -and !$app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $root -Force -Recurse -ErrorAction SilentlyContinue
}
