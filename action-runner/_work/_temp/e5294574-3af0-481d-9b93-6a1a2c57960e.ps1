$ErrorActionPreference = 'stop'
pm2 delete all
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }