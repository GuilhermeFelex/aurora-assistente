@echo off
title Aurora
cd /d "%~dp0"

echo.
echo   A.U.R.O.R.A. - iniciando...
echo   (deixe esta janela aberta enquanto usa a Aurora; feche-a para desligar)
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js nao encontrado. Instale em https://nodejs.org e tente de novo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   Primeira vez: instalando dependencias, pode levar alguns minutos...
  call npm.cmd install
  if errorlevel 1 (
    echo   A instalacao falhou. Veja as mensagens acima.
    pause
    exit /b 1
  )
)

call npm.cmd run aurora
pause
