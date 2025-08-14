$ErrorActionPreference = 'stop'
pm2 save
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }