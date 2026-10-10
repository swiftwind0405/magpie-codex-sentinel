# 远程访问与 Docker 部署

默认本地插件仍然免登录、只监听 127.0.0.1。远程模式面向单管理员：专用 HTTPS 域名 → 反向代理 → Sentinel → 现有 Magpie 网关。远程网页的密码与 Magpie 网关密钥相互独立。无需修改 Magpie 源码、账号或 provider。

## 访问配置

| 插件 / JSON 选项 | CLI | 环境变量 | 含义 |
| --- | --- | --- | --- |
| remoteOrigin | --remote-origin | SENTINEL_REMOTE_ORIGIN | 专用 HTTPS origin，如 https://sentinel.example.com；不支持路径前缀 |
| passwordFile | --password-file | SENTINEL_PASSWORD_FILE | 服务进程可读的密码文件；单行，至少 16 字符、最多 1024 字节；末尾可有一个换行 |
| remoteBind | --remote-bind | SENTINEL_REMOTE_BIND | 远程监听地址；默认 0.0.0.0；宿主反代用 127.0.0.1 |
| port | --port | — | HTTP 后端端口；默认 47821 |

显式选项优先于环境变量。没有 remoteOrigin 时，passwordFile / remoteBind 会报错，避免误以为已启用登录保护。缺失密码、弱密码或非 HTTPS origin 都拒绝启动。不要在密码文件里使用示例密码。

后端 HTTP 只应位于受信网络或 loopback；公网只开放反代的 HTTPS 入口。反代必须保留原始 Host，不能改为 127.0.0.1。Sentinel 不根据任意 X-Forwarded-* 头跳过来源校验。所有响应禁止缓存。

## Linux VPS：与已有 Magpie 共存

仓库 [compose.yaml](../deploy/compose.yaml) 使用 Linux host 网络连接 VPS 已有的 `127.0.0.1:3425` 网关。Sentinel 后端监听宿主 `127.0.0.1:47822`，避开插件原有的 47821。容器以 node 用户运行，根文件系统只读，检测记录持久化到独立 sentinel_data 卷。不挂载 Magpie 的账号凭据目录或 Docker socket。

在源码根目录准备配置（首次部署）：

~~~bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，把 SENTINEL_DOMAIN 改成实际域名。
mkdir -p deploy/secrets
chmod 700 deploy/secrets
# 首次创建；noclobber 防止覆盖已有密码。
( umask 077; set -C; openssl rand -hex 24 > deploy/secrets/sentinel-password )
# 使容器内 UID 1000 可读，父目录仍仅管理员可访问。
sudo chown 1000:1000 deploy/secrets/sentinel-password
sudo chmod 400 deploy/secrets/sentinel-password
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build sentinel
~~~

Magpie 使用自定义网关密钥时，在 deploy/.env 中设置已有的 MAGPIE_GATEWAY_KEY，并将该文件设为 600；不要创建或修改 Magpie 密钥。若网关端口不同，修改 compose 的 --base-url。

在 DNS 管理台添加站点域名指向 VPS。已有宿主 Caddy 时，将下列**独立站点块**加入现有配置，验证后 reload，保留原有站点：

~~~caddyfile
sentinel.example.com {
    reverse_proxy 127.0.0.1:47822
}
~~~

若没有现有反代且 80/443 端口空闲，可使用附带 Caddy：

~~~bash
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile https up -d --build
~~~

Cloudflare 代理开启时应使用 Full (strict)，让浏览器到 Cloudflare、Cloudflare 到 Caddy 两段都使用有效 TLS。附带 Caddy 负责申请和续期证书；域名解析、80/443 入站必须可达。

打开 HTTPS 域名，输入密码即可使用单账号或全部检测。记录位于服务器持久卷，和桌面本地记录独立。登录有效期 12 小时；退出、重启或宿主接管需重新登录。退出登录不会取消检测，需要停止时先在检测台点击停止。

若管理员选择沿用 Magpie Docker 的网页访问密钥，将已有的 `MAGPIE_WEB_KEY` 值写入 Sentinel 密码文件即可；不要把调用模型 API 的 `MAGPIE_GATEWAY_KEY` 当成网页访问密钥。登录页提供查找说明：在部署 Magpie 的 Compose 文件或对应 `.env` 中查看 `MAGPIE_WEB_KEY` 的实际值；他人部署则向管理员索取。若使用独立 Sentinel 密码，仍填写该密码。本机插件默认免登录。

Sentinel 不会自动读取另一个容器的环境变量；这里复用的是当前密钥值。以后轮换 `MAGPIE_WEB_KEY` 时，需要同步更新 Sentinel 密码文件并重启服务。

## 容器桥接网络或 Magpie 插件模式

自定义桥接网络下可使用 remoteBind=0.0.0.0，向可信代理网络暴露后端；需要宿主反代时只映射 `127.0.0.1:47822:47821`。Magpie 必须能从该容器访问。另一个容器里的 loopback 网关不等于 Sentinel 的 loopback，不能仅改 --base-url 主机名就假定可访问。附带的 Linux host 网络方案专门复用宿主已发布到 loopback 的 Magpie。

也可以直接在 Magpie 插件选项里设置 remoteOrigin、passwordFile、remoteBind、port；密码路径指向 **Magpie 宿主或容器内**可读文件。远程插件不会启动服务器浏览器；多个同配置插件宿主通过正常登录边界协调接管。该方式需要给 Magpie 容器挂载密码文件和配置反代网络；已有 Magpie 不方便重建时优先使用独立 Sentinel 容器。

## 运维与回退

~~~bash
docker compose -f deploy/compose.yaml --env-file deploy/.env logs --tail=100 sentinel
docker compose -f deploy/compose.yaml --env-file deploy/.env restart sentinel
docker compose -f deploy/compose.yaml --env-file deploy/.env stop sentinel
~~~

密码文件修改后重启服务，所有登录失效。数据卷应随服务器备份；不要使用 `down -v`，它会删除检测记录。停用远程容器和对应反代站点即可回退，本地插件不受影响。复制旧检测目录到容器属于额外的数据迁移，部署不会自动执行。

安全依据：[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[Docker host 网络说明](https://docs.docker.com/engine/network/drivers/host/)。这些措施不提供多用户隔离；所有持有密码的用户都能读报告和发起消耗额度的检测。

## 带密钥的直接访问链接

使用 `https://你的域名/?k=访问密钥的URL编码值` 可以直接进入，校验后跳转到不含密钥的地址；未携带密钥时仍可在登录页输入。错误密钥会显示明确提示。页面无需退出按钮，会话到期后重新打开带密钥的链接即可。这里的密钥是 Sentinel 密码文件中的值；沿用 Magpie 部署时就是 `MAGPIE_WEB_KEY`。共享这个链接等于共享访问权限。
