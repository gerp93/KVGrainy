; Explorer integration: "Reduce with KVGrainy" on the right-click menu of images and videos.
;
; Windows runs the command once per selected file. The app is single-instance, so every launch
; after the first hands its file to the window that is already open (see lib.rs, `hand_over`).
; SHCTX follows the install mode: HKCU for a per-user install, HKLM for a per-machine one.

!macro KVGRAINY_MENU_KEY KIND
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${KIND}\shell\KVGrainy" "" "Reduce with KVGrainy"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${KIND}\shell\KVGrainy" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${KIND}\shell\KVGrainy\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro KVGRAINY_MENU_REMOVE KIND
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\${KIND}\shell\KVGrainy"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro KVGRAINY_MENU_KEY "image"
  !insertmacro KVGRAINY_MENU_KEY "video"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro KVGRAINY_MENU_REMOVE "image"
  !insertmacro KVGRAINY_MENU_REMOVE "video"
!macroend
