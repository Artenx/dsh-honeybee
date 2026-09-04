# DSH-HoneyBee (DSHB)

<p align="center">
  <img src="assets/dshb-logo.jpg" alt="DSHB" />
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
  <img src="https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat-square" alt="node >=22.13" />
  <img src="https://img.shields.io/badge/status-developing-orange?style=flat-square" alt="status" />
</p>

DSHB lets a single web entry drive execution environments across multiple cloud hosts or Docker containers: the agent loop, LLM calls, sessions, and persistence stay centralized in that unified web entry, while file, command, and terminal operations are transparently dispatched to local or cloud nodes (or containers) for execution. Delivered as plugins with no changes to upstream source, and adapted for mobile browsers so operations are always at hand.

> Pure-plugin delivery for the DSH ecosystem: every capability ships as a DSH plugin (bundle), composed via profile + `cordis.patch.yml`, so you can follow upstream releases.

---

## Features

- **Multi-node execution**: local host, local Docker, remote SSH host, and remote Docker execution nodes; all connections are initiated by the management side
- **Mirror-path + execution-world router**: each remote workspace keeps a local mirror directory as the session cwd (satisfying upstream workspace realpath checks); `ctx.fs` / `ctx.subprocess` / `ctx.shell` / `ctx.terminals` are translated to the real path on the node side
- **Container lifecycle management**: creating a Docker node with an image automatically provisions a container, with "pull up / restart / stop" controls; node online status is validated in three layers (SSH handshake + daemon + container running)
- **On-demand artifact download**: clicking a produced file on a container / remote workspace streams it straight from the node — no need to write back to the local mirror, and Chinese content renders correctly as UTF-8
- **Credential custody**: SSH passwords / private keys / passphrases are centrally managed; connection tests use the live form values
- **Node management Web UI**: node CRUD, connection tests, Docker container controls, directory-tree workspace creation, plus mobile-browser adaptation (paired with dsh-web-mobile)
- **Single-admin authentication**: login page + session cookies to lock down the exposed network entry

## Architecture

DSHB splits into the management side and the execution side:

```
┌──────────────────────── Management side (single DSH process) ────────────────┐
│  dshb-auth auth │ dshb-ui node mgmt / add workspace │ dshb-core registry/heartbeat │
│  dshb-router world router (replaces ctx.fs/shell/subprocess)                  │
└───────────────┬──────────────────────────────────────────────┬──────────────┘
                │ dshb-exec-ssh (SSH exec-line / SFTP / PTY)   │ dshb-exec-docker (Docker Engine API)
        ┌───────▼────────┐  ┌─────────▼────────┐  ┌────────────▼────────────┐
        │ Remote SSH host │  │ Local Docker ctr │  │ Remote Docker (SSH ch.) │
        └────────────────┘  └─────────────────┘  └─────────────────────────┘
```

- **Management side**: the single Web entry point handling authentication, dispatching session instructions, and collecting session output, adapted for desktop and mobile browsers; the agent loop, LLM calls, session logs, and persistence all live here
- **Execution side (work nodes)**: runs on a local/remote host or inside a container, executing file, command, and terminal tasks and returning results to the management side

The core mechanism is "mirror directory + router": remote file operations are routed to the real path on the node. `dshb-router`'s bundled `cordis.patch.yml` disables the host defaults (`bash-sandbox` / `fs-sandbox` / `subprocess`) and replaces them with routing versions — so remote hosts and containers plug in without touching upstream source.

## Packages

| Package | Role |
| --- | --- |
| [dshb](packages/dshb) | Aggregate package — installs all DSHB plugins in one command |
| [dshb-auth](packages/dshb-auth) | Management-side auth and network exposure (login page / session cookie / loopback allow) |
| [dshb-core](packages/dshb-core) | Node registry (`ctx.nodeRegistry`), credential custody, heartbeat, on-demand artifact routes |
| [dshb-router](packages/dshb-router) | Execution-world router — splits `ctx.fs` / `ctx.subprocess` / `ctx.shell` by mirror path |
| [dshb-exec-ssh](packages/dshb-exec-ssh) | Remote SSH execution world (exec-line protocol / SFTP / PTY over ssh2) |
| [dshb-exec-docker](packages/dshb-exec-docker) | Docker container execution world (Docker Engine API + exec / files / PTY) + provisioning |
| [dshb-ui](packages/dshb-ui) | Node management settings page, node-aware "Add workspace" occupant |

## Installation

### Prerequisites

- Node.js >= 22.13
- pnpm >= 11
- A runnable DSH environment (verified against upstream `@deepseek-ai/dsh@0.1.1-rc.2`)
- If you use Docker containers in the cloud (local-docker / remote-docker nodes), make sure a Docker foundation (Docker Engine + daemon) is already installed on the target host yourself — this tool does not install it for you

### One-command install (curl)

Installs standard DSH and all DSHB plugins into the `web` profile in a single command; if a `dsh` binary is already on PATH it skips the DSH install and only installs DSHB:

```sh
curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
```

The script detects `dsh` (skips DSH if present, otherwise pins `@deepseek-ai/dsh@0.1.1-rc.2`), clones this repo, runs `pnpm build`, then installs every DSHB plugin plus `dsh-web-mobile`. Start the management web with the command printed at the end.

Useful overrides: `DSH_HOME` (default `~/.dsh`), `PROFILE` (default `web`), `DSH_VERSION` (default `0.1.1-rc.2`):

```sh
DSH_HOME="$HOME/.dsh-prod" PROFILE=prod \
  curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
```

### Install from source (development)

```sh
# 1. Install dependencies and build all packages
pnpm install
pnpm build

# 2. Install into the web profile in one command
./scripts/install.sh
# Equivalent to: dsh plugin --profile web add packages/dshb-{auth,core,router,exec-ssh,exec-docker,ui}
#               plus dsh-web-mobile

# 3. Restart the management side
dsh web
```

A pre-composed profile (`profiles/dshb`) is also provided: it declares all packages as workspace dependencies and lists the bundles, so after `pnpm install` in the repo it can be used directly as a profile.

### Aggregate package (after npm publish)

```sh
dsh plugin --profile web add dshb
```

The `dshb` aggregate depends on all sub-packages and merges each package's patch rows into a single `cordis.patch.yml` (union), completing the composition in one command; once the sub-packages are published, dependencies resolve automatically from the registry.

### Containerizing DSH itself (optional)

The DSH management side can itself run inside a Docker container. If you also need **local-docker nodes to drive containers on the host**, mount the host's Docker socket when starting the DSH container:

```sh
docker run -d \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -p 3000:3000 \
  -v "$HOME/.dsh:/root/.dsh" \
  <dsh-image> dsh web
```

- local-docker nodes talk to the host Docker Engine API over `docker.sock` — **no docker CLI needed inside the DSH container**; remote-docker / remote-ssh nodes go over SSH and are unaffected
- If the host daemon listens on TCP, inject it via the `DOCKER_HOST` env (e.g. `tcp://host:2375`); both the runner and the execution world honor it
- **local-host nodes always point to the environment the DSH process runs in**: containerized, that is the container itself; to run files/commands on the host, use remote-ssh to the host or local-docker into a container

## Usage

1. Start the management side with `dsh web`, open the console in a browser, and complete first login
2. Go to **Settings → Work Nodes** and add a node:
   - For remote nodes, fill in the SSH host / port / username and auth info; you can "Test Connection" first
   - For Docker nodes, fill in the image and resource limits; saving auto-provisions the container, and the node shows "provisioning" until ready
3. In the session or sidebar, click "Add Workspace", choose an **online** node, and pick a remote directory from the tree
4. Read/write files and run commands on the workspace from the session — operations are routed to the node side
5. Produced files under a container / remote workspace download on demand when clicked

## Documentation

- [Requirements](docs/spec/requirements.md) (EARS, 9 requirement groups)
- [Design](docs/spec/design.md) (architecture, components, data model, correctness invariants, test strategy)
- [Task list](docs/spec/tasklist.md) (phased P0–P5 tasks)

## Development

```sh
pnpm install
pnpm build          # build all packages (tsdown: node ESM + client CJS bundle)
pnpm typecheck      # type check
pnpm test           # vitest unit tests
```

### Upgrading upstream

```sh
./scripts/upgrade.sh [version]    # defaults to the latest dist-tag
```

Automatically bumps every `package.json` → install → build → typecheck → test.

## License

[MIT](LICENSE)
