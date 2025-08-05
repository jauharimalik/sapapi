$ErrorActionPreference = 'stop'
git pull -f origin main
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }