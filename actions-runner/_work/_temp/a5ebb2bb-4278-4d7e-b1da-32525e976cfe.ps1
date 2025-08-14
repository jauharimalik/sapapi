$ErrorActionPreference = 'stop'
echo "C:\Users\PROGRAM-002\AppData\Roaming\npm" | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }