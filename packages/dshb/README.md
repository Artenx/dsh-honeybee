# @artenx/dshb

DSH-HoneyBee routes DSH filesystem, shell, subprocess, and PTY operations to local, SSH, and Docker execution nodes. It includes a node registry, an authentication gate, credential custody, workspace bindings and project instructions, and a mobile-aware management UI.

## Install

```sh
dsh plugin --profile web add @artenx/dshb
```

Restart the corresponding DSH Web profile after installation.

Desktop app: install from **Settings → Plugins → More** in the DSH desktop app; the plugin takes effect on next startup.

The Authentication settings entry appears in the browser-based Web app. The DSH desktop shell loads through `file://` and omits this entry; its loopback requests are admitted automatically.

## Requirements

- Node.js 22.13 or newer
- DeepSeek Harness 0.1.7-rc.1 or 0.2.1-rc.2 (Web or Desktop)

Source code and complete documentation: https://github.com/Artenx/dsh-honeybee
