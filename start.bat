@echo off
chcp 65001 >nul
cd /d "%~dp0bridge"
node src\main.js
pause
