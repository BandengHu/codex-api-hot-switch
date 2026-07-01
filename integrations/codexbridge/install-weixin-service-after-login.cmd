@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\service\install-windows-task.ps1" -DefaultCwd "D:\cully\Documents"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\service\status-windows-task.ps1"
