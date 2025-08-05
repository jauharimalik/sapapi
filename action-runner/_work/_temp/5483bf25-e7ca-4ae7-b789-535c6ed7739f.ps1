$ErrorActionPreference = 'stop'
taskkill /IM C:\laragon\www\sapapi\csx.bat /F
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }