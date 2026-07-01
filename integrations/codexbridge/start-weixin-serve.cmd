@echo off
setlocal
cd /d "%~dp0"
set "CODEX_REAL_BIN=C:\Users\cully\AppData\Roaming\npm\codex.cmd"
set "CODEX_APP_SERVER_TRANSPORT=stdio"
set "CODEXBRIDGE_DEFAULT_CWD=D:\cully\Documents"
set "CODEXBRIDGE_LOCALE=zh-CN"
npm run weixin:serve -- --cwd "D:\cully\Documents"
