$ErrorActionPreference = 'stop'
pm2 list
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }