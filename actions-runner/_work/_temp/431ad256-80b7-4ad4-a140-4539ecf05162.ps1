$ErrorActionPreference = 'stop'
echo "HOMEPATH=C:\Users\PROGRAM-002" | Out-File -FilePath $env:GITHUB_ENV -Append

if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }