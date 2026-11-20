param([Parameter(Mandatory=$true)][string]$Worker)
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('easy-switch-update-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
$original = Get-Location
$originalDirectory = [Environment]::CurrentDirectory
function Assert($condition, $message) { if (!$condition) { throw $message } }
try {
  $jobPath = Join-Path $root 'install.json'
  . $Worker -JobFile $jobPath
  foreach ($scenario in @('success', 'installer-failure', 'version-unchanged', 'startup-unconfirmed', 'corrupt-package', 'parent-running')) {
    $script:events = [Collections.Generic.List[string]]::new()
    $script:scenario = $scenario
    $script:directory = Join-Path $root "User's update $scenario"
    New-Item -ItemType Directory -Path $script:directory | Out-Null
    $installed = Join-Path $root ('Program Files ' + $scenario)
    New-Item -ItemType Directory -Path $installed | Out-Null
    $JobFile = Join-Path $script:directory 'install.json'
    $script:job = [PSCustomObject]@{
      parent = 2147483646
      current = Join-Path $installed 'easy-switch.exe'
      staged = Join-Path $script:directory 'package.exe'
      receipt = Join-Path $script:directory 'pending.json'
      handshake = Join-Path $script:directory 'helper-ready.json'
      version = '1.0.0'
      token = 'fixture-token'
      environment = @{ SWITCH_HOME = 'fixture-switch'; CODEX_HOME = 'fixture-codex' }
    }
    [IO.File]::WriteAllText($script:job.current, 'old app')
    [IO.File]::WriteAllText($script:job.staged, 'verified fixture')
    $script:job | Add-Member size (Get-Item -LiteralPath $script:job.staged).Length
    $script:job | Add-Member sha256 (Get-FileHash -LiteralPath $script:job.staged).Hash
    $script:job | Add-Member ready $false
    [IO.File]::WriteAllText($script:job.receipt, ($script:job | ConvertTo-Json))
    [IO.File]::WriteAllText($JobFile, ($script:job | ConvertTo-Json))
    if ($scenario -eq 'corrupt-package') { [IO.File]::WriteAllText($script:job.staged, 'corrupt') }
    function Get-Process {
      param($Id, $ErrorAction)
      $process = [PSCustomObject]@{ HasExited = $true }
      $process | Add-Member ScriptMethod WaitForExit { param($timeout) $script:events.Add('parent-wait'); return $script:scenario -ne 'parent-running' }
      $process | Add-Member ScriptMethod Dispose { }
      return $process
    }
    function Get-Item {
      param($LiteralPath)
      if ($LiteralPath -ne $script:job.current) { return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath }
      return [PSCustomObject]@{ VersionInfo = @{ ProductVersion = $(if ($script:scenario -eq 'version-unchanged') { '0.5.5.0' } else { '1.0.0.0' }) } }
    }
    function Start-Process {
      param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$PassThru, [switch]$Wait)
      if ($FilePath -eq $script:job.staged) {
        Assert ((Get-Location).Path -eq $script:directory) 'PowerShell location must leave the installation directory'
        Assert ((Split-Path -Leaf ([Environment]::CurrentDirectory)) -eq (Split-Path -Leaf $script:directory)) 'native working directory must leave the installation directory'
        Assert ($WorkingDirectory -eq $script:directory) 'installer working directory must be the update cache'
        Assert $Wait 'installation must wait for elevated installer children'
        Assert ($ArgumentList -eq ('/S --updated /D=' + (Split-Path -Parent $script:job.current))) 'NSIS must target the running copy with /D last and unquoted'
        Assert (Test-Path -LiteralPath $script:job.handshake) 'handshake must exist before installation'
        Assert ($script:events.Contains('parent-wait')) 'installation must wait for the previous process'
        $script:events.Add('installer')
        $process = [PSCustomObject]@{ ExitCode = $(if ($script:scenario -eq 'installer-failure') { 2 } else { 0 }); HasExited = $true }
      } else {
        $script:events.Add('launch')
        $process = [PSCustomObject]@{ HasExited = $true }
        if ($ArgumentList -eq '--updated') {
          Assert ($script:events.Contains('installer')) 'new app may start only after installation'
          Assert ($env:ELECTRON_RUN_AS_NODE -eq $null -or $env:ELECTRON_RUN_AS_NODE -eq '') 'new app must not inherit Electron Node mode'
          Assert ($env:SWITCH_HOME -eq 'fixture-switch') 'custom data directory must survive relaunch'
          if ($script:scenario -ne 'startup-unconfirmed') {
            [IO.File]::WriteAllText($script:job.receipt, (@{ token = $script:job.token; version = $script:job.version; executable = $script:job.current; ready = $true } | ConvertTo-Json))
          }
        }
      }
      $process | Add-Member ScriptMethod Dispose { }
      return $process
    }
    $success = Invoke-EasySwitchUpdate
    $failure = Join-Path $script:directory 'last-error.txt'
    Assert ($success -eq ($scenario -eq 'success')) ($scenario + ': incorrect result; ' + $(if (Test-Path -LiteralPath $failure) { Get-Content -LiteralPath $failure -Raw }))
    if ($success) {
      Assert (!(Test-Path -LiteralPath $script:job.receipt)) 'confirmed receipt should be cleared'
      Assert (!(Test-Path -LiteralPath $script:job.staged)) 'confirmed installer should be cleaned'
    } else {
      Assert (Test-Path -LiteralPath (Join-Path $script:directory 'last-error.txt')) ($scenario + ': failure must be saved')
      Assert (Test-Path -LiteralPath $script:job.staged) 'failed installer must remain available for manual recovery'
      if ($scenario -in @('corrupt-package', 'parent-running')) { Assert (!$script:events.Contains('installer')) 'failed preflight must not run the installer' }
    }
    Write-Output ('PASS ' + $scenario)
  }
} finally {
  Set-Location $original
  [Environment]::CurrentDirectory = $originalDirectory
  Remove-Item -LiteralPath $root -Recurse -Force
}
