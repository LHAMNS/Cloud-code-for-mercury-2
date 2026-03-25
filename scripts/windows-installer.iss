; Mercury Code - Windows Installer (Inno Setup Script)
; Requires: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
;
; Usage:
;   1. Build the Windows binary first:
;      node scripts/build-binaries.js --windows
;   2. Then compile this installer with Inno Setup:
;      iscc scripts/windows-installer.iss
;
; This creates a professional Windows installer EXE that:
;   - Installs mercury-code.exe to Program Files
;   - Adds it to the system PATH
;   - Creates Start Menu shortcuts
;   - Supports per-user or all-users installation
;   - Includes uninstaller

#define MyAppName "Mercury Code"
#define MyAppVersion "1.4.1"
#define MyAppPublisher "Inception Labs"
#define MyAppURL "https://github.com/LHAMNS/Cloud-code-for-mercury-2"
#define MyAppExeName "mercury-code.exe"

[Setup]
AppId={{B8F7D4A2-3E9C-4F1B-A6D5-8C2E7F0B9D3A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={autopf}\MercuryCode
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE.md
OutputDir=..\dist
OutputBaseFilename=mercury-code-v{#MyAppVersion}-windows-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ChangesEnvironment=yes
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "addtopath"; Description: "Add Mercury Code to your user PATH"; GroupDescription: "Additional options:"; Flags: checkedonce
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional options:"; Flags: unchecked

[Files]
; Main executable — use the x64 binary from dist/
Source: "..\dist\mercury-code-v{#MyAppVersion}-win-x64.exe"; DestDir: "{app}"; DestName: "mercury-code.exe"; Flags: ignoreversion
; Also create an alias called "mercury.exe"
Source: "..\dist\mercury-code-v{#MyAppVersion}-win-x64.exe"; DestDir: "{app}"; DestName: "mercury.exe"; Flags: ignoreversion
; License
Source: "..\LICENSE.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--help"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; Add to current-user PATH
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath(ExpandConstant('{app}'))

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--version"; Flags: nowait postinstall skipifsilent runhidden; Description: "Verify installation"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// Check if directory is already in PATH
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Param + ';', ';' + OrigPath + ';') = 0;
end;

// Mark installation in the registry for detection by other tools.
// Note: Inno Setup's ChangesEnvironment=yes directive (in [Setup]) handles
// broadcasting WM_SETTINGCHANGE automatically after installation completes.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'MercuryCodeInstalled', 'yes');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  OrigPath: string;
  NewPath: string;
  AppDir: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    AppDir := ExpandConstant('{app}');
    if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
    begin
      NewPath := OrigPath;
      StringChangeEx(NewPath, ';' + AppDir, '', True);
      StringChangeEx(NewPath, AppDir + ';', '', True);
      StringChangeEx(NewPath, AppDir, '', True);
      RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath);
    end;
    RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'MercuryCodeInstalled');
  end;
end;
