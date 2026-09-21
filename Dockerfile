# GeeWiki 生产镜像（多阶段构建）
#
# 说明：本文件只使用标准 Dockerfile 语法，因此不声明 `# syntax=docker/dockerfile:1`
#      （该指令会要求构建时额外拉取 docker/dockerfile 前端镜像，离线/受限网络下会失败）。
#
#   builder   安装依赖 / 构建前端 / 生成只含生产依赖的部署树
#   runtime   仅携带部署树 + 前端静态产物 + 运行期 tsx，以非 root 用户运行
#
# 设计要点：
#   * 后端各包没有编译产物（exports 直接指向 src/index.ts，由 tsx 在运行时转译），
#     因此 runtime 阶段需要一份固定版本的 tsx；它在 builder 阶段单独安装，
#     不写回 pnpm-lock.yaml，也不污染 --prod 部署树。
#   * better-sqlite3 13.x 自带 prebuilds/**（linux-x64 / linuxmusl-x64 等），运行时优先加载；
#     但 pnpm 11 的 legacy deploy 仍会触发一次原生构建，故 builder 阶段装有
#     python3/make/g++（仅 builder，不进入运行镜像）。
#   * pnpm-workspace.yaml 里的 storeDir/cacheDir 是相对路径，在 builder 内解析为
#     /src/.pnpm-store，无需任何改写（见该文件内的说明）。
#
# 构建：docker build -t geewiki:latest .
# 运行：docker compose up -d --build   （见 docker-compose.yml 与 docs/deployment.md）

# ─────────────────────────────────────────────────────────────────────────────
# 阶段 1：builder
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS builder

ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# 原生模块编译工具链：pnpm 的 legacy deploy 会为 better-sqlite3 调用 node-gyp（见下方 deploy 步骤），
# 因此这里必须安装；它只存在于 builder 阶段，不会进入最终镜像。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# 先复制清单文件，命中 layer cache：依赖未变时跳过安装
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/db-sqlite/package.json ./packages/db-sqlite/
COPY packages/manager/package.json ./packages/manager/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/plugin-wiki/package.json ./packages/plugin-wiki/
COPY packages/plugin-echo/package.json ./packages/plugin-echo/

# 安装 pnpm：**不使用 corepack**。
# Node 26 起官方镜像已不再内置 corepack —— 在 node:26-bookworm-slim 上执行
# `corepack enable` 会直接报 `/bin/sh: 1: corepack: not found`（exit 127，已实测），
# 这曾使 Dependabot 的 node 22→26 升级 PR 的镜像构建卡住。
# 改用 npm 全局安装（npm 仍随 Node 发布）；版本从 package.json 的 packageManager
# 字段解析，与仓库保持一致，避免像原先那样在两处硬编码 11.7.0 而漂移。
# 必须放在 COPY 清单之后：读取 packageManager 需要 package.json 已就位。
RUN PNPM_VERSION="$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '')")" \
    && echo "pnpm version: ${PNPM_VERSION}" \
    && npm install -g --no-audit --no-fund "pnpm@${PNPM_VERSION}" \
    && pnpm --version

RUN pnpm install --frozen-lockfile

# 复制源码并构建前端（vite build → packages/web/dist）
COPY . .

# 内置插件的界面产物（`packages/web/dist/plugins-ui/@geewiki/**`）是**生成物**，
# 必须在 `vite build` 之前生成，否则镜像里的 web dist 只有外壳：
#
#   * 该目录落在 `packages/web/public/plugins-ui/`，而 `packages/web/public/plugins-ui/`
#     被 .gitignore 忽略（生成物不入库）⇒ **干净检出里根本不存在它**；
#   * 唯一的生成者是 `build:builtin-ui` / `build:fixtures`，而 `build`（= `vite build`）
#     不生成它 —— 它只负责把 publicDir 拷进 dist（见 fixtures/vite.config.ts 文件头）；
#   * 于是从干净检出构建出的镜像，所有内置插件的界面都会报"界面产物缺失"。
#     出厂清单默认启用 ops / ai-summary / ai-assistant 三个带界面的插件，
#     因此这是**开箱即见**的问题，不是个别配置导致的。
#
# 顺序不可颠倒：本步写入 `public/`，紧随其后的 `pnpm -r run build` 才把它拷进 `dist/`。
RUN pnpm --filter @geewiki/web run build:builtin-ui

RUN pnpm -r --if-present run build \
    && test -f packages/web/dist/index.html

# 回归守卫：内置插件界面产物必须齐全。宁可构建失败，也不要再出一个
# "插件界面凭空消失"的镜像 —— 这类故障在构建期完全静默，只在用户界面上表现为缺失。
RUN for p in ai-assistant ai-summary editor-plain oidc ops; do \
      test -d "packages/web/dist/plugins-ui/@geewiki/$p" \
        || { echo "缺少内置插件界面产物: $p"; exit 1; }; \
    done

# 生成生产部署树：--legacy 兼容共享 lockfile 的 workspace 结构。
# 注意（已实测）：pnpm 11 的 legacy deploy 仍会对 better-sqlite3 执行原生安装脚本，
# 即便设置 npm_config_ignore_scripts=true 也会调用 node-gyp，因此 builder 阶段
# 必须自带 python3/make/g++；编译产物与该包自带的 prebuilds/** 在运行时都可用
# （lib/binding.js 优先使用 prebuilds）。
RUN pnpm --filter @geewiki/server deploy --legacy --prod /deploy \
    && test -d /deploy/node_modules/@geewiki/db-sqlite \
    && test -d /deploy/node_modules/@geewiki/manager

# 运行期 TypeScript 执行器：版本直接取自 lockfile 实际安装的那一份，避免与仓库漂移
RUN TSX_VERSION="$(node -p "require('/src/node_modules/tsx/package.json').version")" \
    && echo "runtime tsx version: ${TSX_VERSION}" \
    && npm install --prefix /opt/tsx --no-package-lock --no-audit --no-fund "tsx@${TSX_VERSION}" \
    && /opt/tsx/node_modules/.bin/tsx --version

# ─────────────────────────────────────────────────────────────────────────────
# 阶段 2：runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime

# 运行期默认值。注意 GEEWIKI_PLUGINS_DIR 必须是**绝对路径**：部署树里没有
# pnpm-workspace.yaml，resolveProjectPath() 找不到仓库根时会回退到 process.cwd()，
# 于是任何覆盖 WORKDIR 的启动方式（docker run -w、自定义 entrypoint）都会让插件发现
# 静默指向别处——不报错、0 个插件。固定为 /app/plugins 后与 compose 的挂载点一致。
ENV NODE_ENV=production \
    HOME=/home/node \
    GEEWIKI_PORT=3000 \
    GEEWIKI_DATA_DIR=/app/data \
    GEEWIKI_CONFIG_DIR=/app/config \
    GEEWIKI_PLUGINS_DIR=/app/plugins \
    GEEWIKI_WEB_DIST=/app/packages/web/dist \
    PATH=/opt/tsx/node_modules/.bin:$PATH

WORKDIR /app

# 部署树：服务端源码 + 全部生产依赖（@geewiki/* 与 cordis）
COPY --from=builder /deploy /app

# 前端静态产物（由后端静态托管，含 SPA fallback）
COPY --from=builder /src/packages/web/dist /app/packages/web/dist

# 运行期 tsx（含 esbuild 平台二进制）
COPY --from=builder /opt/tsx /opt/tsx

# 默认插件清单：**只把"随版本发布的默认值"模板打进镜像**，绝不 COPY 整个 config/。
#
# 为什么不是 `COPY /src/config /app/config`（曾经的写法）：构建上下文里的 config/ 是**开发者
# 本机目录**，里面有 secrets.json（模型 API key）与 plugins.base.json（本机的模型/端点/开关）。
# 整个 COPY 进去 = 把密钥连同镜像一起分发，而且不会有任何测试或报错提示。
# 已实测那一版：探测构建的 /cfg 里确实躺着 secrets.json（.dockerignore 当时只排除了 session）。
# 现在 .dockerignore 对 config/ 是**默认拒绝**，只放行这一个模板。
#
# 为什么镜像里必须有它：缺了默认清单，未挂载 ./config 的容器会读到「空清单」→ 没有任何插件
# 被激活 → HTTP 不监听，进程随即以退出码 0 结束，并被 restart 策略反复拉起，形成静默重启循环、
# 对外完全不服务（已实测：日志仅剩「http 路由服务不可用：REST API 未挂载」，端口无监听）。
# 模板与 live 清单的读取回退见 packages/manager/src/index.ts 的 readBaseList。
# 放在下面的权限归一化之前，以便一并 chown/chmod。
COPY --from=builder /src/config/plugins.base.example.json /app/config/plugins.base.example.json

# 权限归一化：
#   * pnpm deploy 生成的部署树里，少量文件权限为 600（root:root），非 root 运行时会被
#     tsx 在解析模块时拒绝读取（Error: EACCES: permission denied, open '/app/package.json'）。
#     这里用 find 只对**确实缺少全局读位/进入位**的条目补 `go+rX`（实测恰好 26 个文件，
#     600 → 644、700 → 755，`X` 保证可执行文件不被降级），而不是整树 `chmod -R a+rX`：
#     既不放宽本来已正确的权限，也保留了「任意 uid 运行」的能力（compose 用
#     GEEWIKI_UID/GID 对齐宿主用户时，若宿主 gid ≠ 1000，仅放开组权限会失效）。
#   * 数据 / 配置 / 插件挂载点预创建并归属 node（uid 1000）。
#     使用绑定挂载时宿主目录属主需对应（见 docs/deployment.md）。
RUN mkdir -p /app/data /app/config /app/plugins \
    && find /app /opt/tsx ! -perm -o+r -exec chmod go+rX {} + \
    && find /app /opt/tsx -type d ! -perm -o+x -exec chmod go+x {} + \
    && chown -R node:node /app/data /app/config /app/plugins

# 容器以 node 用户而非 root 运行
USER node

EXPOSE 3000

# 容器内自检：仅当 /api/health 返回 ok:true **且** db.present:true（SQLite 已连接）才算健康。
# 只判 HTTP 200 是不够的：数据目录不可写时 db-sqlite 激活失败，接口仍返回 200 且
# db.present:false，此时容器会被误判为 healthy 而页面接口全部 404（已实测反证）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.GEEWIKI_PORT||3000)+'/api/health').then(r=>r.json()).then(j=>process.exit(j&&j.ok===true&&j.db&&j.db.present===true?0:1)).catch(()=>process.exit(1))"

# 服务端注册了 SIGTERM/SIGINT 优雅退出（卸载插件、关闭 DB）；
# PID 1 的僵尸进程回收由 compose 的 init: true 负责。
# 入口写绝对路径：与上面 GEEWIKI_* 的绝对化同理，避免任何 -w / 自定义 WORKDIR
# 让容器连入口都解析不到（相对 "src/index.ts" 会按 cwd 解析而失败）。
CMD ["tsx", "/app/src/index.ts"]
