# DSHB Web 应用部署手册（Docker + Nginx）

DSHB（dsh web）是一个基于 WebSocket 的 Web 应用，前端通过 WS 长连接获取 workspace/session 实时数据。本文档记录在 CentOS 7 服务器上以 Docker 容器方式部署 DSHB 的完整流程和踩坑经验。所有 IP、密码、域名、密钥均为占位符，实际部署时由秘密管理系统注入。

## 1. 环境限制与方案选型

CentOS 7（glibc 2.17, gcc 4.8.5, python2）存在以下硬性限制，导致**无法在宿主机直接运行 dsh**：

| 限制 | 影响 | 尝试过的失败路线 |
|------|------|------------------|
| glibc 2.17 | 官方 Node.js 22 二进制要求 glibc ≥ 2.17（部分构建需 ≥ 2.28） | 非官方 glibc-217 build 可装但仅解决 Node 本体 |
| gcc 4.8 / python2 | node-pty、cpu-features、koffi 等 native 模块编译失败（python2 不支持 walrus 语法） | devtoolset-9/11 在 CentOS 7 EOL 仓库中不可用 |
| libstdc++ 3.4.19 | sharp 报 `ERR_DLOPEN_FAILED: GLIBCXX_3.4.20 not found` | conda 安装 g++ 也失败（最新 miniconda 需 glibc ≥ 2.28） |

**结论**：放弃宿主机原生部署，改用 Docker 容器（`node:22-bookworm-slim`）隔离环境。容器内 glibc 2.36 + gcc 12 + python3，所有 native 模块可正常编译运行。

## 2. Docker 容器部署

### 2.1 数据目录规划

```bash
# 宿主机持久化目录（容器通过 volume 挂载）
install -d -o root -g root -m 700 /root/.dshb/dsh-honeybee   # 源码 + 构建产物
install -d -o root -g root -m 700 /root/.dsh                   # dsh 运行数据（profiles/sessions/storages）
```

### 2.2 启动脚本

创建 `/tmp/start-dshb.sh`，容器入口执行。脚本完成：安装系统依赖 → 全局安装 pnpm + dsh CLI → 构建 dsh-honeybee → 配置 profile → 启动 web 服务。

```bash
#!/bin/bash
export CI=true
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PNPM_STORE_DIR=/root/.local/share/pnpm/store

# 安装系统依赖
apt-get update -qq
apt-get install -y -qq git python3 make g++ >/dev/null 2>&1

# 安装 pnpm 和 dsh CLI
npm install -g pnpm@11 @deepseek-ai/dsh@<VERSION> >/dev/null 2>&1

# 构建 DSHB
cd /app
pnpm install >/dev/null 2>&1
pnpm build >/dev/null 2>&1

# 配置 profile
export DSH_HOME=/data/dsh
mkdir -p $DSH_HOME/profiles/web
cd $DSH_HOME/profiles/web

# package.json 中 host 依赖使用 link:/app/packages/... 指向容器内源码
# （此处省略 package.json 内容，需包含所有 @deepseek-ai/dsh-client-* 依赖
#   以及 dshb-auth/dshb-core/dshb-ui 等本地包的 link 引用）

# pnpm-workspace.yaml 必须配置 hoisted + publicHoistPattern
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - .
nodeLinker: hoisted
publicHoistPattern: ["*"]
autoInstallPeers: true
EOF

pnpm install >/dev/null 2>&1

# 启动 web — 监听 0.0.0.0（详见第 3 节 容器端口绑定踩坑）
dsh web --host 0.0.0.0 --no-open
```

### 2.3 创建容器

```bash
docker run -d --name dshb-web \
  --restart unless-stopped \
  -p 127.0.0.1:3080:3080 \
  -v /root/.dshb/dsh-honeybee:/app \
  -v /root/.dsh:/data/dsh \
  -v /tmp/start-dshb.sh:/start.sh \
  node:22-bookworm-slim \
  bash /start.sh
```

挂载说明：
- `/app`（源码 + node_modules + 构建产物）：重建容器不丢失
- `/data/dsh`（运行数据：profiles、sessions、storages）：重建容器不丢失
- `/start.sh`：启动脚本，修改后需重建容器生效

### 2.4 快速重建（docker commit 快照）

首次构建完成后，用 `docker commit` 保存快照镜像，后续重建无需重跑 pnpm install/build：

```bash
# 保存快照（含已安装的全局 CLI 和系统依赖）
docker commit dshb-web dshb-snapshot:latest

# 基于快照重建，直接启动 dsh（跳过构建步骤）
docker rm -f dshb-web
docker run -d --name dshb-web --restart unless-stopped \
  -p 127.0.0.1:3080:3080 \
  -v /root/.dshb/dsh-honeybee:/app \
  -v /root/.dsh:/data/dsh \
  dshb-snapshot:latest \
  bash -lc 'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export DSH_HOME=/data/dsh; cd $DSH_HOME/profiles/web && exec dsh web --host 0.0.0.0 --no-open'
```

## 3. 容器端口绑定踩坑

**现象**：容器内 dsh 监听 `127.0.0.1:3080`，nginx 代理 `127.0.0.1:3080` 返回 502 Bad Gateway。

**根因**：Docker 端口映射 `-p 127.0.0.1:3080:3080` 由 docker-proxy 将宿主 `127.0.0.1:3080` 转发到**容器 eth0**（`172.17.0.x:3080`）。如果容器内服务只监听 `127.0.0.1`（容器自身的 loopback），docker-proxy 转发到 eth0 时连接被拒 → 502。

**正确做法**：
- 容器内服务监听 `0.0.0.0`（容器所有网卡，含 eth0）
- Docker 端口映射绑定 `127.0.0.1:3080:3080`（宿主侧只绑 loopback，外部不可直连）
- Nginx 代理 `127.0.0.1:3080`

这样外部只能通过 nginx（443）访问，容器端口不暴露公网。

## 4. Nginx 反向代理与 WebSocket

**现象**：HTTPS 能返回 302 → /login（HTTP 层正常），但新建工作区后出现"未分组会话"，刷新页面后所有工作区消失。

**根因**：DSHB 前端通过 WebSocket 获取 workspace/session 实时数据。Nginx 反向代理缺少 WS 升级头导致：
- WS 握手失败 → 前端拿不到 workspace 列表 → 刷新后空白
- WS 不稳定 → session 创建后前端未收到 workspace 关联更新 → 显示"未分组"

**修复**：Nginx 配置必须包含 `Upgrade`/`Connection` 透传 + 长超时。

创建 `/etc/nginx/conf.d/<DOMAIN>.conf`：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    client_max_body_size 50m;
    listen 80;
    server_name <DOMAIN>;
    return 301 https://$host$request_uri;
}

server {
    client_max_body_size 50m;
    listen 443 ssl;
    server_name <DOMAIN>;

    ssl_certificate /etc/nginx/ssl/dsh-fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/dsh-privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;

        # WebSocket 升级头 — 必须配置
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Port $server_port;

        # WebSocket 长连接超时 — 默认 60s 会断开 WS
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

`map $http_upgrade` 必须在 `server` 块之外（http 上下文）。`conf.d/*.conf` 被 `nginx.conf` 的 http 块 include，所以放在文件顶部即可。

验证：
```bash
nginx -t && nginx -s reload
# HTTP 层
curl -sk -o /dev/null -w "%{http_code}" https://<DOMAIN>/
# 预期: 302
```

## 5. pnpm 与 native 模块配置

### 5.1 pnpm store 不一致

**现象**：`ERR_PNPM_UNEXPECTED_STORE` — pnpm 在 `/data/dsh` 下找不到预期的 store。

**修复**：统一设置 `PNPM_STORE_DIR`，确保容器内 pnpm store 路径一致：

```bash
export PNPM_STORE_DIR=/root/.local/share/pnpm/store
```

### 5.2 peer deps 解析失败

**现象**：dsh loader 无法解析 peer 依赖（dsh-scope、dsh-subagent-in-process-driver 等），报 "loader entries failed to apply"。

**修复**：`pnpm-workspace.yaml` 配置 hoisted 模式 + 全量提升 + 自动安装 peer：

```yaml
packages:
  - .
nodeLinker: hoisted
publicHoistPattern: ["*"]
autoInstallPeers: true
```

### 5.3 native 模块构建失败

**现象**：node-pty、cpu-features、koffi 等 native 模块在 pnpm install 时触发 node-gyp 编译失败（python2 walrus 语法错误 / gcc 版本不足）。

**修复**：
1. `pnpm-workspace.yaml` 中将 `allowBuilds` 对 native 模块设为 `false`，跳过编译
2. `~/.npmrc` 设置 `ignore-scripts=true`，禁止 install 时执行构建脚本
3. node-pty 的 prebuild 二进制手动放置：

```bash
# 容器内复制 prebuild 二进制到 node-pty 期望的路径
cp node-pty/prebuilds/linux-x64/pty.node node-pty/build/Release/node_pty.node
```

### 5.4 profile package.json 路径重写

**现象**：容器内 profile 的 `package.json` 中 `link:` 引用指向宿主机路径（`/root/.dshb/...`），但容器内挂载为 `/app`，导致 pnpm install 无法解析。

**修复**：profile `package.json` 中所有本地包的 `link:` 路径必须改写为容器内路径：

```json
{
  "dshb-auth": "link:/app/packages/dshb-auth",
  "dshb-core": "link:/app/packages/dshb-core",
  "dshb-ui": "link:/app/packages/dshb-ui"
}
```

## 6. SSL 证书自动续期

DSHB 复用腾讯云 SSL DNS_AUTO 续期方案。为独立域名创建续期脚本：

```bash
install -d -o root -g root -m 700 /opt/dshb/ssl
```

续期脚本 `/opt/dshb/ssl_renew.py` 关键配置项（基于腾讯云 SSL DNS_AUTO 续期方案模板修改）：

```python
DOMAIN = '<DOMAIN>'                          # 续期域名
SECRET_ID = '<SECRET_ID>'                    # 腾讯云 AK（或用环境变量 TC_SSL_SECRET_ID 覆盖）
SECRET_KEY = '<SECRET_KEY>'                  # 腾讯云 SK（或用环境变量 TC_SSL_SECRET_KEY 覆盖）
CERT_DIR = '/opt/dshb/ssl'                   # 证书输出目录
NGINX_CERT = '/etc/nginx/ssl/dsh-fullchain.pem'   # nginx 证书路径
NGINX_KEY = '/etc/nginx/ssl/dsh-privkey.pem'      # nginx 私钥路径
STATE_FILE = '/var/lib/tencent-ssl-renew/<DOMAIN>.state'
RENEW_BEFORE_DAYS = 30
```

cron 定时任务（与现有续期任务错开时间）：

```bash
# 编辑 root crontab
crontab -e

# 添加（每天 03:30 执行，与 baby-ed 的 03:00/03:05 错开）
30 3 * * * cd /opt/dshb && PYTHONIOENCODING=utf-8 python3 ssl_renew.py >> /var/log/dshb-ssl-renew.log 2>&1
```

首次手动执行以签发证书：

```bash
cd /opt/dshb && PYTHONIOENCODING=utf-8 python3 ssl_renew.py
# 签发完成后证书自动复制到 /etc/nginx/ssl/ 并 nginx -s reload
```

## 7. 排错速查

| 现象 | 原因 | 解决 |
|------|------|------|
| 502 Bad Gateway | 容器内服务监听 127.0.0.1，docker-proxy 转发到 eth0 失败 | 服务监听 0.0.0.0，映射仍绑 127.0.0.1 |
| 502 Bad Gateway | docker daemon 间歇性不可达 | 命令加幂等重试循环（12 次 × 10s） |
| 刷新后工作区消失 | nginx 缺 WebSocket 升级头 | 加 `proxy_set_header Upgrade/Connection` + `map` |
| 新建工作区出现"未分组会话" | WS 不稳定，session 关联未同步到前端 | 同上，修复 WS 配置 |
| pnpm ERR_PNPM_UNEXPECTED_STORE | store 路径不一致 | 统一 `PNPM_STORE_DIR` |
| native 模块编译失败 | python2/gcc 4.8 不足 | `allowBuilds: false` + `ignore-scripts=true` + prebuild 手动放置 |
| sharp ERR_DLOPEN_FAILED | libstdc++ 版本不足 | 使用 Docker 容器（bookworm glibc 2.36） |
| `link:` 路径解析失败 | profile package.json 指向宿主机路径 | 改写为容器内 `/app/packages/...` |

## 8. SSH 跳板访问

目标服务器如需通过跳板机访问，文件上传采用两段式：

```bash
# 1. 本地 → 跳板机
sshpass -p '<JUMP_PASSWORD>' scp -P <JUMP_PORT> local-file.sh <JUMP_USER>@<JUMP_HOST>:/tmp/

# 2. 跳板机 → 目标服务器（跳板已配置免密）
ssh -p <JUMP_PORT> <JUMP_USER>@<JUMP_HOST> "scp -o BatchMode=yes /tmp/local-file.sh root@<SERVER_IP>:/tmp/"
```

远程执行命令同理嵌套 SSH。避免引号嵌套地狱的方法：将多步操作写成脚本文件上传后执行，而非在嵌套 SSH 中拼接复杂命令。

## 9. Docker Daemon 稳定性

CentOS 7 上 Docker daemon 可能间歇性不可达（`Cannot connect to the Docker daemon at unix:///var/run/docker.sock`），表现为：

- `docker ps` / `docker logs` 偶发失败并输出 CLI help 文本
- `docker.service` 日志显示重启循环
- 通常 30-90 秒后自行恢复

应对策略：
1. 所有 docker 命令包裹幂等重试循环
2. 避免在单条嵌套 SSH 中串联多个 docker 命令（中间步骤失败后续命令拿不到上下文）
3. 将完整操作写成脚本上传执行，脚本内含重试逻辑
