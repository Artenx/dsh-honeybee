# DSH-HoneyBee (DSHB)

<p align="center">
  <img src="assets/dshb-logo.jpg" alt="DSHB" width="80" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <strong>A cloud-native agent workbench built on deepseek-harness — start turning your ideas into reality, anywhere.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT" /></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square" alt="dsh-plugin" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/upstream-dsh%400.1.1--rc.2-blue?style=flat-square" alt="upstream dsh 0.1.1-rc.2" /></a>
  <img src="https://img.shields.io/badge/status-developing-orange?style=flat-square" alt="status" />
</p>

A single web entry drives execution environments across multiple cloud hosts or Docker containers. The agent loop, LLM calls, sessions, and persistence stay centralized in the management side, while file, command, and terminal operations are transparently dispatched to local or remote nodes. Delivered as plugins with no changes to upstream source. Adapted for mobile browsers so operations are always at hand.

---

## Features

- **Multi-node execution**: local host, local Docker, remote SSH, and remote Docker execution nodes — all connections initiated by the management side
- **Container lifecycle management**: creating a Docker node with an image auto-provisions a container, with pull-up / restart / stop controls
- **On-demand artifact download**: click a produced file on a container or remote workspace to stream it straight from the node — no write-back needed
- **Credential custody**: SSH passwords and private keys centrally managed by the management side
- **Node management UI**: node CRUD, connection tests, directory-tree workspace creation, with built-in mobile-screen adaptation
- **Single-admin authentication**: login page + session cookies to lock down the exposed network entry

## Installation

### Prerequisites

- Node.js >= 22.13
- pnpm >= 11
- A runnable DSH environment
- Docker Engine pre-installed on the target host if using Docker nodes

### One-command deploy

```sh
curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
```

The script detects `dsh` (skips if present, installs otherwise), clones the repo, builds, and installs all plugins. Start `dsh web` when done.

Useful overrides: `DSH_HOME` (default `~/.dsh`), `PROFILE` (default `web`):

```sh
DSH_HOME="$HOME/.dsh-prod" PROFILE=prod \
  curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
```

### Install from source

```sh
pnpm install
pnpm build
./scripts/install.sh    # installs into the web profile
dsh web
```

### Aggregate package (after npm publish)

```sh
dsh plugin --profile web add @artenx/dshb
```

## Usage

1. Start `dsh web`, open the console in a browser, and complete first login
2. Go to **Settings → Work Nodes** and add a node (SSH or Docker); you can "Test Connection" first
3. Click "Add Workspace" in the session area, choose an online node, and pick a remote directory from the tree
4. Read/write files and run commands on the workspace from the session — operations are routed to the node automatically
5. Produced files under a container or remote workspace download on demand when clicked

## Documentation

- [Requirements](docs/spec/requirements.md)
- [Design](docs/spec/design.md)
- [Task list](docs/spec/tasklist.md)

## License

[MIT](LICENSE)
