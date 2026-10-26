#define MyAppName "ForeverDB Companion"
#define MyAppVersion "0.9.0-alpha"
#define MyAppPublisher "ForeverDB"
#define MyAppExeName "ForeverDB.Companion.exe"

[Setup]
AppId={{D3297746-8DDF-4B1A-AFB3-76D3650F7740}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\ForeverDB
DefaultGroupName=ForeverDB
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\artifacts\installer
OutputBaseFilename=ForeverDB-Companion-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#MyAppName}

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked
Name: "autostart"; Description: "Launch ForeverDB Companion with Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "..\artifacts\ForeverDB-Companion-win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Zero-touch enrollment: an activation file placed next to Setup (the website's "Download for my account") is handed to the
; Companion's per-user activation folder. The Companion redeems it on first start and deletes it afterwards; Setup only copies it
; (never reads it) and never removes it or any ForeverDB user data on uninstall.
Source: "{src}\foreverdb-activation*.fdbact"; DestDir: "{localappdata}\ForeverDB\activation"; Flags: external skipifsourcedoesntexist ignoreversion uninsneveruninstall

[Icons]
Name: "{group}\ForeverDB Companion"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\ForeverDB Companion"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ForeverDB Companion"; ValueData: """{app}\{#MyAppExeName}"" --minimized"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch ForeverDB Companion"; Flags: nowait postinstall skipifsilent
