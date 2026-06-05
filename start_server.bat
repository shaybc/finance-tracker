@echo off
setlocal

cd /d "%~dp0"

if not exist "package.json" (
    if exist "code\package.json" (
        cd /d "%~dp0code"
    )
)

start "" "http://localhost:5173"
npm run dev
