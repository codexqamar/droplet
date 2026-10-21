; DROPLET installer hooks (Tauri NSIS).
;
; Every install and upgrade (including silent /S) must leave a desktop shortcut, a Start menu
; entry and an Apps & features entry that all show the DROPLET icon, never a blank or generic
; exe icon. Shortcuts carry no separate icon path: Explorer takes the icon embedded in the target
; exe (the build fails if that icon is missing). An explicit icon path is stored as a literal
; string, so when the installer runs under file-system redirection (for example launched from a
; packaged app) it points at a folder Explorer cannot see and the shortcut renders blank; the
; target, by contrast, is resolved to the real location. The shell icon cache is refreshed after.

!macro DROPLET_REFRESH_ICONS
  ; SHCNE_ASSOCCHANGED: Explorer drops cached icons and re-reads them.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x0000, p 0, p 0)'
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
  Pop $0
!macroend

!macro DROPLET_SHORTCUT PATH
  Delete "${PATH}"
  CreateShortCut "${PATH}" "$INSTDIR\${MAINBINARYNAME}.exe" "" "" 0 SW_SHOWNORMAL "" "${PRODUCTNAME} trade portal"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  !insertmacro DROPLET_SHORTCUT "$DESKTOP\${PRODUCTNAME}.lnk"
  CreateDirectory "$SMPROGRAMS"
  !insertmacro DROPLET_SHORTCUT "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ; Apps & features icon: the exe's embedded icon.
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  !insertmacro DROPLET_REFRESH_ICONS
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro DROPLET_REFRESH_ICONS
!macroend
