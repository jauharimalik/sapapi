@echo off
setlocal

:: Mendapatkan path dari direktori skrip ini
set "SCRIPT_DIR=%~dp0"

:: Mendapatkan path absolut ke file skrip Node.js
set "NODE_SCRIPT=%SCRIPT_DIR%dnt.js"
set "NODE_SCRIPT=%SCRIPT_DIR%dnpg.js"

:: Jalankan skrip Node.js
echo Menjalankan dnt.js...
node "%NODE_SCRIPT%"

echo.
echo Selesai.
pause