/*
 * Dusk Cellar — Windows 실행 파일 (이름_cellar.exe)
 * 리스 폴더의 bin\node.exe 로 Dusk-Cellar\cellar-start.cjs 를 실행해 리스 + Dusk Cellar를 함께 켠다.
 * 빌드: gcc -municode -O2 -o cellar-launcher-win-x64.exe cellar-launcher.c -lshell32   (.github/workflows/launcher.yml)
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <wchar.h>

int wmain(void) {
    WCHAR dir[MAX_PATH], buf[MAX_PATH], cmd[MAX_PATH * 4], port[16], title[MAX_PATH];
    GetModuleFileNameW(NULL, dir, MAX_PATH);
    WCHAR *sep = wcsrchr(dir, L'\\');
    if (sep) { wcsncpy(title, sep + 1, MAX_PATH - 1); title[MAX_PATH - 1] = 0; *sep = 0; } else title[0] = 0;
    WCHAR *dot = wcsrchr(title, L'.'); if (dot) *dot = 0;
    SetConsoleTitleW(title[0] ? title : L"Dusk Cellar");
    SetCurrentDirectoryW(dir);

    if (!GetEnvironmentVariableW(L"PORT", port, 16)) wcscpy(port, L"7777");
    SetEnvironmentVariableW(L"PORT", port);

    swprintf(buf, MAX_PATH, L"%ls\\bin\\node.exe", dir);
    if (GetFileAttributesW(buf) == INVALID_FILE_ATTRIBUTES) { wprintf(L"[Error] bin\\node.exe not found. Keep this exe inside the Risu folder.\n"); system("pause"); return 1; }
    swprintf(buf, MAX_PATH, L"%ls\\Dusk-Cellar\\cellar-start.cjs", dir);
    if (GetFileAttributesW(buf) == INVALID_FILE_ATTRIBUTES) { wprintf(L"[Error] Dusk-Cellar folder not found.\n"); system("pause"); return 1; }

    swprintf(buf, MAX_PATH, L"http://localhost:%ls", port);
    ShellExecuteW(NULL, L"open", buf, NULL, NULL, SW_SHOWNORMAL);

    swprintf(cmd, MAX_PATH * 4, L"\"%ls\\bin\\node.exe\" \"%ls\\Dusk-Cellar\\cellar-start.cjs\" --risu \"%ls\\server\\node\\server.cjs\" --data-dir \"%ls\\Dusk-Cellar\\dusk-data\"", dir, dir, dir, dir);
    STARTUPINFOW si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si); ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, dir, &si, &pi)) { wprintf(L"[Error] Failed to start (error %lu).\n", GetLastError()); system("pause"); return 1; }
    WaitForSingleObject(pi.hProcess, INFINITE);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    system("pause");
    return 0;
}
