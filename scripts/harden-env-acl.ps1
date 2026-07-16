[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [Parameter()]
  [string] $Path = '.env'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
  throw "The requested environment file does not exist."
}

$resolvedPath = (Resolve-Path -LiteralPath $Path).Path
$existingAcl = Get-Acl -LiteralPath $resolvedPath
$ownerAccount = [System.Security.Principal.NTAccount]::new($existingAcl.Owner)
$ownerSid = $ownerAccount.Translate([System.Security.Principal.SecurityIdentifier])
$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')

if (-not $PSCmdlet.ShouldProcess(
  $resolvedPath,
  'Replace inherited access with FullControl for the current owner, Administrators, and SYSTEM only'
)) {
  return
}

$hardenedAcl = [System.Security.AccessControl.FileSecurity]::new()
$hardenedAcl.SetOwner($ownerSid)
$hardenedAcl.SetAccessRuleProtection($true, $false)

foreach ($principal in @($ownerSid, $administratorsSid, $systemSid)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $principal,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void] $hardenedAcl.AddAccessRule($rule)
}

Set-Acl -LiteralPath $resolvedPath -AclObject $hardenedAcl

$result = Get-Acl -LiteralPath $resolvedPath
$expectedSids = @($ownerSid.Value, $administratorsSid.Value, $systemSid.Value) |
  Sort-Object -Unique
$actualSids = @($result.Access | ForEach-Object {
  $_.IdentityReference.Translate(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
}) | Sort-Object -Unique

if (
  -not $result.AreAccessRulesProtected -or
  (Compare-Object -ReferenceObject $expectedSids -DifferenceObject $actualSids)
) {
  throw "The resulting environment-file ACL did not match the required principals."
}

Write-Output "Owner: $($result.Owner)"
$result.Access |
  Select-Object `
    @{ Name = 'Principal'; Expression = { $_.IdentityReference.Value } },
    @{ Name = 'Type'; Expression = { $_.AccessControlType } },
    @{ Name = 'Permissions'; Expression = { $_.FileSystemRights } } |
  Format-Table -AutoSize
