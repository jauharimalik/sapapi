$ErrorActionPreference = 'stop'
npm install -g pm2
npm install

if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }