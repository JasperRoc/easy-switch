$ErrorActionPreference = 'Stop'

function Open-LockedFile($file, $attempts) {
  $stream = [IO.File]::Open($file, 'OpenOrCreate', 'ReadWrite', 'ReadWrite, Delete')
  try {
    for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
      try {
        # One byte overlaps the exclusive whole-file range locked by Codex.
        $stream.Lock(0, 1)
        return $stream
      } catch {
        $code = $_.Exception.GetBaseException().HResult -band 0xffff
        if ($code -ne 33) { throw }
        if ($attempt + 1 -lt $attempts) { Start-Sleep -Milliseconds 50 }
      }
    }
  } catch {
    $stream.Dispose()
    throw
  }
  $stream.Dispose()
}

$locks = @()
try {
  $job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())) | ConvertFrom-Json
  [void][IO.Directory]::CreateDirectory($job.directory)
  $coordination = Open-LockedFile (Join-Path $job.directory '.coordination.lock') 20
  if (!$coordination) { [Console]::WriteLine('busy'); return }
  try {
    foreach ($id in $job.ids) {
      $lock = Open-LockedFile (Join-Path $job.directory ($id + '.lock')) 1
      if (!$lock) { [Console]::WriteLine('busy'); return }
      $locks += $lock
    }
  } finally { $coordination.Dispose() }

  [Console]::WriteLine('ready')
  # The pipe closes on completion or if easy-switch exits.
  [void][Console]::ReadLine()
} catch {
  [Console]::WriteLine('error')
} finally {
  foreach ($lock in $locks) { $lock.Dispose() }
}
