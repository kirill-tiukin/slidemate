@echo off
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "installed="
py -3 -c "import sys; sys.exit(sys.version_info < (3,9))" >nul 2>&1
if errorlevel 1 (
  echo Installing Python for SlideMate...
  winget install --id Python.Python.3.12 --exact --source winget
  if errorlevel 1 goto failed
  set "installed=yes"
)
where pdftotext.exe >nul 2>&1
if errorlevel 1 (
  echo Installing Poppler for textbook and lecture PDFs...
  winget install --id oschwartz10612.Poppler --exact --source winget
  if errorlevel 1 goto failed
  set "installed=yes"
)
where codex.exe >nul 2>&1
if errorlevel 1 (
  echo Installing Codex for ChatGPT sign-in...
  winget install --id OpenAI.Codex --exact --source winget
  if errorlevel 1 goto failed
  set "installed=yes"
)
if defined installed goto reopen
codex.exe login status >nul 2>&1
if errorlevel 1 (
  codex.exe login
  if errorlevel 1 goto failed
)
py -3 scripts\windows_start.py
if errorlevel 1 goto failed
exit /b 0
:reopen
echo Close this window and open Start SlideMate.cmd again to continue setup.
pause
exit /b 0
:failed
echo Setup or startup did not finish. See the message above and the Windows instructions in README.md.
pause
exit /b 1
