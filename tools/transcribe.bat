@echo off
chcp 65001 >nul
title 녹취 전사
set PYTHONIOENCODING=utf-8
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
set HF_HUB_DISABLE_IMPLICIT_TOKEN=1
cd /d "%~dp0"
rem Same Python packages and model as Kakashi, kept outside Dropbox
set "VENV=%LOCALAPPDATA%\kakashi\venv"
set "PY=%VENV%\Scripts\python.exe"

if exist "%PY%" goto run
echo [처음 실행] 전사 프로그램을 설치합니다. 몇 분 걸립니다...
where py >nul 2>nul && (py -3 -m venv "%VENV%") || (python -m venv "%VENV%")
if not exist "%PY%" (
  echo.
  echo Python이 설치되어 있지 않습니다.
  echo https://www.python.org/downloads/ 에서 설치하세요. 설치할 때 "Add python.exe to PATH"를 체크하세요.
  pause
  exit /b 1
)
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install faster-whisper nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10" "av>=11,<19"
if errorlevel 1 (
  echo 설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행하세요.
  rmdir /s /q "%VENV%"
  pause
  exit /b 1
)

:run
"%PY%" tools\transcribe.py
echo.
pause
