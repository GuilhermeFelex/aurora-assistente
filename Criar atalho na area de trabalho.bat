@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Aurora.lnk')); $s.TargetPath=(Join-Path '%~dp0' 'Iniciar Aurora.bat'); $s.WorkingDirectory='%~dp0'; $s.Description='Iniciar a assistente Aurora'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,138'; $s.Save()"
if errorlevel 1 (
  echo   Nao consegui criar o atalho.
) else (
  echo   Atalho "Aurora" criado na sua area de trabalho.
)
pause
