@echo off
ECHO Starting deployment process...
echo.

REM --- Step 1: Stop all running Node.js processes ---
ECHO Killing all existing Node.js processes...
taskkill /F /IM node.exe /T

REM Wait to ensure all processes are terminated
timeout /t 5 > nul

REM --- Step 2: Pull the latest code from the repository ---
ECHO Pulling the latest code from Git...
cd /d C:\laragon\www\sapapi
git pull

REM --- Step 3: Start all Node.js servers in the background ---
ECHO Starting all Node.js applications...
echo.

ECHO Starting Delivery Note (server.js)...
start /b nodemon server.js

ECHO Starting Tukar Guling (guling.js)...
start /b nodemon guling.js

ECHO Starting Retur (retur.js)...
start /b nodemon retur.js

ECHO Starting Rejection (rijek.js)...
start /b nodemon rijek.js

ECHO Starting STO (sto.js)...
start /b nodemon sto.js

echo.
ECHO Deployment complete.