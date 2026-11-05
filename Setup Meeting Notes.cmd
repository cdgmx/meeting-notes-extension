@echo off
setlocal DisableDelayedExpansion
title Meeting Notes helper setup

echo Install the Meeting Notes extension in Chrome first, then copy its ID from chrome://extensions.
set "MEETING_EXTENSION_ID="
set /p "MEETING_EXTENSION_ID=Chrome extension ID: "
powershell.exe -NoProfile -NonInteractive -Command "if ($env:MEETING_EXTENSION_ID -cnotmatch '^[a-p]{32}$') { [Console]::Error.WriteLine('Invalid extension ID. Expected 32 lowercase letters from a to p.'); exit 1 }; if (-not [Environment]::Is64BitOperatingSystem) { [Console]::Error.WriteLine('A 64-bit Windows installation is required.'); exit 1 }"
if errorlevel 1 goto failed
set "MEETING_STAGE=%TEMP%\MeetingNotesSetup-%RANDOM%-%RANDOM%"
if exist "%MEETING_STAGE%" goto stage_conflict
mkdir "%MEETING_STAGE%" 2>nul
if errorlevel 1 goto failed

echo Downloading and verifying the official Node runtime...
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $zip = Join-Path $env:MEETING_STAGE 'node.zip'; $web = [Net.WebClient]::new(); try { $web.DownloadFile('https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip', $zip) } finally { $web.Dispose() }; $stream = [IO.File]::OpenRead($zip); $sha = [Security.Cryptography.SHA256]::Create(); try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose(); $sha.Dispose() }; if ($hash -cne 'CBC74B5E0982C9DBB41525FD8FB5DCD32FBEE237863F7829072F4639A1CE5F20') { throw 'Node download checksum does not match. Setup stopped.' }; [void][Reflection.Assembly]::Load('System.IO.Compression.FileSystem'); [IO.Compression.ZipFile]::ExtractToDirectory($zip, $env:MEETING_STAGE)"
if errorlevel 1 goto cleanup_failed
set "MEETING_RUNTIME_DIR=%MEETING_STAGE%\node-v22.23.4-win-x64"
echo Installing the local helper and its locked dependencies...
"%MEETING_RUNTIME_DIR%\node.exe" "%~dp0windows-helper.mjs"
if errorlevel 1 goto cleanup_failed
rd /s /q "%MEETING_STAGE%"
echo.
echo Setup complete. Reload Meeting Notes in chrome://extensions, then open Notes connection and sign in.
pause
exit /b 0

:cleanup_failed
rd /s /q "%MEETING_STAGE%"
:failed
echo.
echo Setup did not complete. Read the error above and see README.md for recovery.
pause
exit /b 1

:stage_conflict
echo Temporary setup folder already exists. No files were changed.
goto failed
