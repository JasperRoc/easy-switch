param([Parameter(Mandatory=$true)][string]$JobFile, [switch]$RunUpdate)
$ErrorActionPreference = 'Stop'

function Invoke-EasySwitchUpdate {
  $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $directory = Split-Path -Parent $JobFile
  $parentExited = $false
  $installer = $null
  $application = $null
  try {
    # Neither this worker nor the installer may hold the installation directory open.
    Set-Location -LiteralPath $directory
    [Environment]::CurrentDirectory = $directory
    if (!(Test-Path -LiteralPath $job.current -PathType Leaf) -or
        !(Test-Path -LiteralPath $job.staged -PathType Leaf)) {
      throw 'The Windows update files are unavailable. Download the update again.'
    }
    if ((Get-Item -LiteralPath $job.staged).Length -ne $job.size -or
        (Get-FileHash -LiteralPath $job.staged -Algorithm SHA256).Hash -ne $job.sha256) {
      throw 'Update package SHA-256 verification failed.'
    }
    $parent = Get-Process -Id $job.parent -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $directory 'last-error.txt') -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($job.handshake, (@{ token = $job.token; ready = $true } | ConvertTo-Json))
    if ($parent) {
      try { if (!$parent.WaitForExit(60000)) { throw 'The previous application did not exit. Close easy-switch before retrying the update.' } }
      finally { $parent.Dispose() }
    }
    $parentExited = $true
    # NSIS requires /D= last and unquoted, including when the path contains spaces.
    # The worker owns relaunch; --force-run would make the installer start an unverified app.
    $arguments = '/S --updated /D=' + (Split-Path -Parent $job.current)
    # -Wait includes elevated installer children; --force-run is deliberately omitted.
    $installer = Start-Process -FilePath $job.staged -ArgumentList $arguments -WorkingDirectory $directory -PassThru -Wait
    if ($installer.ExitCode -ne 0) { throw ('The Windows installer failed (exit code ' + $installer.ExitCode + '). Run the downloaded installer manually.') }
    $version = (Get-Item -LiteralPath $job.current).VersionInfo.ProductVersion -replace '\+.*$', ''
    $expected = ($job.version -split '-', 2)[0]
    if ($version -ne $expected -and $version -ne ($expected + '.0')) { throw 'The Windows installer did not replace this copy of easy-switch. Run the downloaded installer manually in the existing installation folder.' }
    foreach ($name in @('SWITCH_HOME', 'CODEX_HOME')) {
      [Environment]::SetEnvironmentVariable($name, $job.environment.$name, 'Process')
    }
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')
    $application = Start-Process -FilePath $job.current -ArgumentList '--updated' -WorkingDirectory (Split-Path -Parent $job.current) -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $accepted = $false
    do {
      try {
        $receipt = Get-Content -LiteralPath $job.receipt -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($receipt.ready -and $receipt.token -eq $job.token -and $receipt.version -eq $job.version -and
            $receipt.executable -eq $job.current) { $accepted = $true; break }
      } catch { }
      if ($application.HasExited) { break }
      Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$accepted) { throw 'The updated Windows application did not confirm startup. Reopen easy-switch to see the update error.' }
    Remove-Item -LiteralPath $job.receipt -Force
    Remove-Item -LiteralPath $job.staged -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $job.handshake -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    $message = $_.Exception.Message
    [IO.File]::WriteAllText((Join-Path $directory 'last-error.txt'), $message)
    if (!$parentExited) {
      [IO.File]::WriteAllText($job.handshake, (@{ token = $job.token; error = $message } | ConvertTo-Json))
    } elseif ((!$installer -or $installer.HasExited) -and !$application -and (Test-Path -LiteralPath $job.current -PathType Leaf)) {
      # Reopen the surviving copy so the failure is visible instead of silently quitting.
      try { Start-Process -FilePath $job.current -WorkingDirectory (Split-Path -Parent $job.current) | Out-Null } catch { }
    }
    return $false
  } finally {
    if ($installer) { $installer.Dispose() }
    if ($application) { $application.Dispose() }
  }
}

if ($RunUpdate) {
  if (!(Invoke-EasySwitchUpdate)) { exit 1 }
}
