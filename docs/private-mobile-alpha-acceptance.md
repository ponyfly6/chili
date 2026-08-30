# Chili 私网手机控制既有任务 Alpha 验收

此 Alpha 的链路为浏览器页面 → 私网 HTTPS → `PrivateControlHttpsHost` → `HostBridge` → 桌面窗口使用的同一个 `DesktopControlService` → 真实 sidecar/runtime。只有测试模型使用本机 fixture；没有用 fake mobile、mock adapter 或 mock control service 替代链路。

它只允许当前工作区已有的顶层任务列表、有限快照、Queue、Steer、Stop。任务创建、工作区选择、子智能体内部任务、审批/提问答复、权限和凭据修改均留在桌面。不包含公网 relay、账号、后台 daemon、原生 App 或离线缓存。

## 启动与网络准备

1. 在本 worktree 安装依赖并构建：`bun install --frozen-lockfile`、`bun run typecheck`、`bun run desktop:build`。
2. 电脑和手机接入同一可信局域网或已由用户配置好的私网 VPN。选定电脑的私网地址和端口，例如 `192.168.1.20:4743`。不要使用公网监听地址、路由器端口转发或公网代理。确认现有网络策略允许手机访问该地址；程序不会更改 VPN 或防火墙。
3. 自行准备匹配**实际访问主机名或 IP 的 SAN**、有效期内、手机浏览器正常信任的 TLS 证书及其私钥。可以使用已有企业/私网 PKI，或人工建立仅供测试的本地 CA。私钥只放在电脑上，限制文件权限，不要发送给手机或提交 Git。
4. 若采用本地 CA，需要用户自行把 **CA 公钥证书**安装为手机信任源。iPhone 通常还需在“设置 → 通用 → 关于本机 → 证书信任设置”开启该 CA 的完全信任；Android 的证书安装入口由厂商和工作资料配置决定。仅安装服务器证书、点击证书警告继续或关闭校验不等同于可信 HTTPS。验收结束按需要人工移除测试 CA。程序和 E2E 都不会修改系统信任库。
5. 从准备好环境变量的终端启动桌面；启动后远控仍然默认关闭：

```sh
CHILI_REMOTE_BIND_ADDRESS=192.168.1.20 \
CHILI_REMOTE_PORT=4743 \
CHILI_REMOTE_ORIGIN=https://192.168.1.20:4743 \
CHILI_REMOTE_TLS_CERT=/absolute/private-pki/server.pem \
CHILI_REMOTE_TLS_KEY=/absolute/private-pki/server-key.pem \
CHILI_REMOTE_WEB_ROOT="$PWD/apps/control-web/dist" \
bun run desktop
```

`CHILI_REMOTE_ORIGIN` 必须与手机输入的 URL（包括端口）完全一致。证书必须匹配这个地址；使用另一个主机名、端口或 Origin 会被拒绝。桌面中的远控面板会报告配置错误。保持桌面和目标工作区打开；关闭桌面不是后台托管方式。

## 临时测试证书示例（不修改任何信任库）

已有受信证书可跳过。以下命令只在本地生成有效期 7 天的测试 CA/服务器证书；请先把 IP 换成电脑**现有的私网地址**。CA 私钥和服务器私钥都不可离开电脑；手机只需 `ca.pem` 公钥证书，由用户手工安装和确认信任。不要把这个测试 CA 用于其他业务。

```sh
CHILI_TEST_IP=192.168.1.20
CHILI_TEST_TLS="$PWD/.chili/phone-tls"
umask 077
mkdir -p "$CHILI_TEST_TLS"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 7 \
  -subj '/CN=Chili private phone test CA' \
  -keyout "$CHILI_TEST_TLS/ca.key" -out "$CHILI_TEST_TLS/ca.pem" \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:2048 -nodes \
  -subj '/CN=Chili private phone test' \
  -keyout "$CHILI_TEST_TLS/server-key.pem" -out "$CHILI_TEST_TLS/server.csr"
cat > "$CHILI_TEST_TLS/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$CHILI_TEST_IP
EOF
openssl x509 -req -sha256 -days 7 -in "$CHILI_TEST_TLS/server.csr" \
  -CA "$CHILI_TEST_TLS/ca.pem" -CAkey "$CHILI_TEST_TLS/ca.key" -CAcreateserial \
  -extfile "$CHILI_TEST_TLS/server.ext" -out "$CHILI_TEST_TLS/server.pem"
```

上述命令需要支持 `req -addext` 的 OpenSSL。若使用主机名，应改成 `subjectAltName=DNS:实际主机名` 并确保手机解析到电脑私网地址。证书警告未消除时不要点击继续验收；先处理 SAN、有效期和手机信任配置。程序不提供明文 HTTP 回退。

## 3–5 分钟真机验收清单

- **0:00–0:45，准备已有任务。** 桌面创建一个普通任务，并让另一个任务运行足够久以便测试排队和打断。打开远控面板、开启远控、生成一次性配对码。在手机正常浏览器输入桌面展示的 HTTPS URL。确认没有证书警告，并且页面有明确连接状态。
- **0:45–1:30，配对。** 手机输入短期配对码和设备名称；提交后应等待桌面本地确认，不能直接操作任务。桌面对照设备信息确认后，手机应显示当前工作区的已有任务。验证没有任意路径、创建任务、权限设置、凭据或子智能体内部任务入口。
- **1:30–2:30，查看与发送。** 打开已有任务，确认有限消息和任务状态。在运行任务发送一条 Queue，确认它排队且不抢占当前执行；发送一条 Steer，确认运行任务转向新输入。同时用桌面发送/查看同一任务，检查两端状态一致且消息没有重复。遇到审批或提问时，手机只提示回桌面处理。
- **2:30–3:15，Stop 与网络恢复。** 在运行任务点击 Stop，确认任务停止且界面有反馈。关闭手机网络片刻再恢复，点击重连；不能把“结果未知”当成发送失败重新创建一条同样请求。确认既有消息未因重连重复执行。刷新页面后本轮授权不恢复，应明确提示重新配对。
- **3:15–4:15，撤销与失效。** 重新配对后在桌面撤销该设备，手机后续请求必须失败。再次配对并关闭远控，手机失效；重新开启不应让旧授权复活。切换工作区或重启桌面后也必须重新开启/配对。
- **4:15–5:00，窄屏检查。** 手机纵屏下列表、消息输入、Queue/Steer/Stop 和错误提示可见可点；页面无横向溢出。记下手机型号、系统版本、浏览器版本、网络类型、证书来源和发现的问题。

**当前真机状态：尚未执行 iPhone 或 Android 真机验收。** 浏览器窄屏截图、viewport 模拟和 Playwright 的浏览器自动化都不是手机真机测试，不应据此填写真机通过。

## 自动化证据与边界

远程浏览器入口：`bun run test:e2e:remote`。测试为 Node 执行的 Playwright harness，使用真实 Electron 窗口、独立工作区/用户数据目录、真实本地 HTTP 模型 fixture 和 HTTPS socket。优先使用本机已有的 RFC1918/CGNAT 网卡地址；本轮使用 `192.168.1.6`，浏览器和 Host 在同一台电脑。无合适网卡时退到 loopback 并在证据中明确记录，不能写成跨设备 LAN 验收。运行前需要桌面声明的 Playwright 浏览器与 `openssl`、NSS `certutil`：

```sh
cd apps/desktop
bun node_modules/playwright-core/cli.js install firefox
```

测试临时生成 CA 与服务器证书，仅通过 `certutil -d sql:<temporary-profile>` 导入本轮 Firefox profile。没有 `ignoreHTTPSErrors:true`、全局证书错误忽略参数或系统 Keychain 操作。独立未信任浏览器必须拒绝同一服务器，然后受信任 profile 才能正常打开页面。页面还证明 `isSecureContext` 和 WebCrypto Ed25519 签名/验签可用。故障注入器的网络转取也使用正常 TLS 校验，只对本轮 Node 进程通过 `NODE_EXTRA_CA_CERTS` 信任同一临时 CA。

主流程通过真实页面按钮完成配对、本地确认、列表、快照、Queue、Steer、Stop、重连、刷新重新配对和撤销。另一真实浏览器页面载入同一个生产 `BrowserControlClient`，只在真实 HTTPS 响应到达后选择丢弃加密 ACK、加密结果或两者；Host、adapter、service 和 runtime 均未替换。测试核对重发保持原 request ID/sequence，队列只有一项，真实 runtime 只执行一次；丢结果后仍然报告 `outcome_unknown`。另有未收到快照结果时的并发 Stop，以及真实桌面重启后的旧授权失效。工作区切换测试仅为系统选目录对话框提供本轮临时目录；点击桌面按钮后的 IPC、service、旧 sidecar 停止、新 sidecar 启动都是真实实现。

每次运行输出独立证据目录 `apps/desktop/out/remote-control-e2e/<UTC timestamp>/`，包含 HTTPS 校验证据、执行结果、浏览器和桌面截图及 trace；失败也保留现场。临时 profile、工作区与 PKI 在系统临时目录中。原始 trace 可能包含已经撤销的测试授权，因此仅供本地排错，不作为公开附件发布。模型 fixture 的输出只用于可重复验收，不代表真实模型质量。

完整门禁结果由集成验收写入本节，不能以仅启动页面替代全链路成功：

| 门禁 | 结果 |
| --- | --- |
| 可信 HTTPS 早期探针 | 通过：未信任 Firefox 拒绝；隔离 NSS 信任后 HTTPS 200、secure context、Ed25519 验签通过 |
| 远程浏览器全链路 | 通过：主智能体全构建独立复跑；Firefox 153、192.168.1.6 私网 HTTPS；配对/读写/Stop/恢复/撤销/重启/工作区切换全部通过，零 pageerror |
| Electron E2E | 通过：主智能体在最新构建复跑全部 4 轮；Goal 恢复、审批、提问、Steer/Stop、rename/search/archive 和 1440/820/390 布局 |
| typecheck | 通过：所有 workspace、desktop、control-web 和 E2E 类型检查 |
| 全量测试 | 通过：主智能体完整串行复跑，2533 pass、0 fail、16296 assertions、208 files |
| smoke:all | 通过：10/10（含 team model / team parallel） |
| 隔离 smoke:desktop（正常/失败/终止） | 通过：主智能体最新源码独立打包复跑；正常双启动、签名/fuses/ASAR/泄漏审计、Git/tool 清理与父进程 SIGKILL；独立真实运行 SIGTERM exit 143、临时目录删除、零本轮后代残留 |
| high audit | 通过：bun audit --audit-level=high；独立安全审查发现的 P1/P2 全部修复并回归 |
| iPhone / Android 真机 | **未测** |


## 最终复验记录

基点 `9192224`；独立分支 `codex/private-mobile-alpha`。7 个子智能体按测试隔离、桌面适配、浏览器客户端、网络配对、移动界面、端到端验收和独立安全审查分工；主智能体负责契约、集成和上述独立复跑。不自动合并，也不修改系统证书、VPN、防火墙或发布公网服务。

主智能体完整构建的浏览器证据：`apps/desktop/out/remote-control-e2e/2026-08-30T16-10-15-810Z/`。该轮普通 Stop 为 **192 ms**，未收到快照结果时 Stop 为 **235 ms**；这是同机私网测试的观测值，不是跨设备网络时延保证。最终截图同步断言复跑证据：`apps/desktop/out/remote-control-e2e/2026-08-30T16-12-08-540Z/`。两轮均使用真实浏览器、正常证书校验、真实桌面和 runtime，不使用 fake mobile、mock adapter 或 mock control service。

丢 ACK 时可以由认证结果恢复准入；丢结果/两者时重连只重传同一个 request ID/sequence，仍为一条队列项、一次 runtime 执行，并显示结果未知。额外边界测试模拟 runtime 已接收但 HTTP 响应失败，证明远程来源的队列项不自动回队；快照 `deliveryUnknown` 提示持续保留，不因重新配对而伪装成已知结果。该项下游故障证明是 service 边界行为测试，与上面的真实浏览器网络丢帧测试分开记录。

隔离证据和主智能体门禁日志已保留在 `apps/desktop/out/alpha-verification/`。四个原有真实 Chili 进程在正常、失败、终止及最终独立复跑后都保持原 PID 与启动时间；同 executable 哨兵和共享 release 的内容、权限、mtime 不变也有行为测试。一次并行打包负载下的全量测试曾遇到旧 sidecar 凭据管道启动失败；未放宽断言，定向复跑通过，并另做无并行打包的完整串行复验，2533 项全部通过。

唯一尚未执行的验收层是 **iPhone / Android 真机**。请按上面的清单记录设备、系统、浏览器、证书和私网信息；不要把 Firefox/Chrome 窄屏自动化签为真机通过。
