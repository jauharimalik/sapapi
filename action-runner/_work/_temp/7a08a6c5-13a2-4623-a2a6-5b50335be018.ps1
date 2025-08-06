$ErrorActionPreference = 'stop'
taskkill /IM csx.bat /F
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }