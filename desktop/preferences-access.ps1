param([Parameter(Mandatory=$true)][string]$PreferenceFile)
$ErrorActionPreference = 'Stop'
try {
  $file = Get-Item -LiteralPath $PreferenceFile -Force
  $parent = Get-Item -LiteralPath $file.DirectoryName -Force
  if ($file.Name -ne 'desktop.json' -or $file.PSIsContainer -or
      ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    'unsupported-file'; exit 0
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $file.FullName
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
    'different-owner'; exit 0
  }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if (@($rules | Where-Object { $_.AccessControlType -eq 'Deny' }).Count -gt 0) {
    'explicit-deny'; exit 0
  }
  $read = [Security.AccessControl.FileSystemRights]::ReadData
  if (@($rules | Where-Object { $_.IdentityReference.Value -eq $sid.Value -and
      $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $read) -eq $read }).Count -gt 0) {
    'already-granted'; exit 0
  }
  # Repair only this user's own desktop preferences. Never grant other identities
  # access, take ownership, remove denies, or touch provider credentials.
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $file.FullName -AclObject $acl
  'repaired'
} catch { exit 1 }
