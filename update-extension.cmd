@echo off
setlocal EnableExtensions
chcp 65001 >nul
title MOEX Price Scanner - обновление

set "REPO_DIR=%~dp0"

echo.
echo MOEX Price Scanner: проверка обновлений
echo Папка: %REPO_DIR%
echo.

where git >nul 2>nul
if errorlevel 1 goto no_git

git -C "%REPO_DIR%" rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto no_repo

git -C "%REPO_DIR%" remote get-url origin >nul 2>nul
if errorlevel 1 goto no_remote

git -C "%REPO_DIR%" diff --quiet --ignore-submodules --
if errorlevel 1 goto dirty_repo

git -C "%REPO_DIR%" diff --cached --quiet --ignore-submodules --
if errorlevel 1 goto dirty_repo

for /f "delims=" %%H in ('git -C "%REPO_DIR%" rev-parse --short HEAD') do set "BEFORE_COMMIT=%%H"

echo Загружаю актуальную версию...
echo.
git -C "%REPO_DIR%" pull --ff-only
if errorlevel 1 goto pull_failed

for /f "delims=" %%H in ('git -C "%REPO_DIR%" rev-parse --short HEAD') do set "AFTER_COMMIT=%%H"

echo.
if /I "%BEFORE_COMMIT%"=="%AFTER_COMMIT%" (
  echo Уже установлена актуальная версия: %AFTER_COMMIT%
) else (
  echo Обновление установлено: %BEFORE_COMMIT% -^> %AFTER_COMMIT%
)

echo.
echo Сейчас откроется страница расширений Chrome.
echo 1. Найдите MOEX Price Scanner.
echo 2. Нажмите кнопку с круглой стрелкой "Обновить".
echo 3. Вернитесь в терминал и нажмите Ctrl+Shift+R.
echo.

call :open_chrome_extensions
pause
exit /b 0

:open_chrome_extensions
set "CHROME_EXE="
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if defined CHROME_EXE (
  start "" "%CHROME_EXE%" "chrome://extensions/"
) else (
  start "" "chrome://extensions/"
)
exit /b 0

:no_git
echo ОШИБКА: Git не найден.
echo Установите Git for Windows, затем снова запустите этот файл.
echo https://git-scm.com/download/win
echo.
pause
exit /b 1

:no_repo
echo ОШИБКА: файл запущен не из клонированного Git-репозитория.
echo Сначала клонируйте репозиторий, затем запускайте update-extension.cmd внутри него.
echo.
pause
exit /b 1

:no_remote
echo ОШИБКА: у репозитория не настроен remote origin.
echo Используйте папку, созданную командой git clone.
echo.
pause
exit /b 1

:dirty_repo
echo ОШИБКА: в файлах расширения есть локальные изменения.
echo Обновление остановлено, чтобы ничего не потерять.
echo Обратитесь к человеку, который устанавливал расширение.
echo.
pause
exit /b 1

:pull_failed
echo.
echo ОШИБКА: Git не смог получить обновление.
echo Проверьте интернет и доступ к репозиторию, затем повторите запуск.
echo.
pause
exit /b 1
