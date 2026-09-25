param([Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference = 'Stop'
# Environment values are passed as arguments, never interpreted as a shell command.
& artifact-signing-cli -e $env:AZURE_SIGNING_ENDPOINT -a $env:AZURE_SIGNING_ACCOUNT -c $env:AZURE_SIGNING_PROFILE -d Trestl $File
if ($LASTEXITCODE -ne 0) { throw "Windows signing failed: $LASTEXITCODE" }
