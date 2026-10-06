@echo off
rem Desliga a Aurora: encerra os processos que estao escutando nas portas dela
rem (8787 = cerebro, 5173 = interface). Funciona com o Windows em qualquer idioma.
setlocal enabledelayedexpansion
set achou=0
for %%P in (8787 5173) do (
  for /f "tokens=2,5" %%a in ('netstat -ano') do (
    echo %%a | findstr /r /c:":%%P *$" >nul && (
      taskkill /PID %%b /T /F >nul 2>nul
      set achou=1
    )
  )
)
if /i "%~1"=="silencioso" exit /b 0
if "!achou!"=="1" (
  echo   Aurora desligada.
) else (
  echo   A Aurora nao estava rodando.
)
timeout /t 3 >nul
