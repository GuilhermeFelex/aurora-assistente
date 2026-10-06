@echo off
title Aurora - instalar Llama local
cd /d "%~dp0"

echo.
echo   Instala o Ollama e baixa o modelo Llama que a Aurora usa no seu PC.
echo   (gratis, roda offline; o modelo tem alguns GB, entao pode demorar)
echo.

rem Modelo configurado em aurora\perfil.json -> llama.modelo (padrao: llama3.1:8b)
set "MODELO=llama3.1:8b"
for /f "usebackq delims=" %%m in (`node -e "try{const p=require('./aurora/perfil.json');process.stdout.write((p.llama&&p.llama.modelo)||'llama3.1:8b')}catch{process.stdout.write('llama3.1:8b')}" 2^>nul`) do set "MODELO=%%m"

where ollama >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama"
  ) else (
    echo   Instalando o Ollama pelo winget...
    winget install -e --id Ollama.Ollama
    if errorlevel 1 (
      echo.
      echo   Nao deu para instalar pelo winget. Baixe em https://ollama.com/download,
      echo   instale e rode este arquivo de novo.
      pause
      exit /b 1
    )
    set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama"
  )
)

rem O Ollama precisa estar rodando para baixar o modelo.
ollama list >nul 2>nul
if errorlevel 1 (
  echo   Ligando o Ollama...
  start "" /min ollama serve
  timeout /t 6 /nobreak >nul
)

echo.
echo   Baixando o modelo %MODELO%...
ollama pull %MODELO%
if errorlevel 1 (
  echo.
  echo   O download falhou. Confira a internet e rode este arquivo de novo.
  pause
  exit /b 1
)

echo.
echo   Pronto! Teste rapido:
ollama run %MODELO% "Responda so: tudo certo."
echo.
echo   Agora reinicie a Aurora (Iniciar Aurora.bat) para ela usar o Llama.
pause
