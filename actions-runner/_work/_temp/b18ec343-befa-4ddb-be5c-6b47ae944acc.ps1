$ErrorActionPreference = 'stop'
pm2 start prod.js --name "prod-service" --watch --ignore-watch "node_modules"
pm2 start grpo.js --name "grpo-service" --watch --ignore-watch "node_modules"
pm2 start guling.js --name "guling-service" --watch --ignore-watch "node_modules"
pm2 start retur.js --name "retur-service" --watch --ignore-watch "node_modules"
pm2 start rijek.js --name "rijek-service" --watch --ignore-watch "node_modules"
pm2 start sto.js --name "sto-service" --watch --ignore-watch "node_modules"
pm2 start server.js --name "server-service" --watch --ignore-watch "node_modules"

if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }