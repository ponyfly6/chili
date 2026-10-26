import type { Metadata } from "next";
import { cliVersion, installCommand, npmAvailable, releaseUrl } from "../release";
import { InstallCommand } from "./InstallCommand";
import "./download.css";

export const metadata: Metadata = {
  title: "安装 Chili CLI · 一条命令开始",
  description: "安装 Chili 命令行开发预览，连接自己的模型服务，在本地项目中开始工作。支持 macOS Apple Silicon 和 Linux。",
  alternates: { canonical: "https://usechili.com/download" },
};

export default function DownloadPage() {
  return <>
    <header className="site-header shell">
      <a className="brand" href="/" aria-label="Chili 首页"><img src="/chili-icon.svg" width="36" height="36" alt="" /><span>chili</span><span className="brand-name">辣椒</span></a>
      <a className="text-link" href={releaseUrl}>v{cliVersion} 发布说明 ↗</a>
    </header>
    <main className="download-main shell">
      <div className="section-kicker">CHILI CLI · 开发预览</div>
      <h1>一条命令，<br />开始动手。</h1>
      <p className="download-intro">在终端安装 Chili，进入你的项目，交代第一件事。<br />独立安装包自带运行时，无需先装 Node.js 或 Bun。</p>
      <section className="download-install" aria-labelledby="install-heading">
        <h2 id="install-heading">01 / 安装</h2>
        <InstallCommand command={installCommand} />
        <p>macOS Apple Silicon · Linux arm64 / x64（glibc 2.28+）</p>
        <p>安装到 <code>~/.local/bin/chili</code>。安装器校验下载文件，支持重复运行以更新。<a href="/install.sh">查看安装脚本</a></p>
        {npmAvailable && <><p>已经有 Node.js 20+？也可以用 npm：</p><InstallCommand command="npm install -g usechili" /></>}
        <p className="download-note">这是命令行版本。桌面安装包、Intel Mac、Windows 和 Alpine/musl 暂未发布。</p>
      </section>
      <section className="download-install" aria-labelledby="setup-heading">
        <h2 id="setup-heading">02 / 连接模型，开始工作</h2>
        <p>配置你自己的模型 API Key。模型调用由对应服务商计费。</p>
        <pre><code>{'export MINIMAX_API_KEY="你的 API Key"\ncd 你的项目目录\nchili "总结这个仓库，指出下一步值得改进的地方"'}</code></pre>
        <p>使用 DeepSeek：设置 <code>DEEPSEEK_API_KEY</code>，然后运行 <code>chili --model deepseek "你的需求"</code>。<a href="https://github.com/ponyfly6/chili#使用">查看全部模型配置 ↗</a></p>
        <p>直接输入 <code>chili</code> 可进入连续对话；用 <code>chili --help</code> 查看命令。</p>
      </section>
      <section className="download-install" aria-labelledby="verify-heading">
        <h2 id="verify-heading">03 / 验证、更新与卸载</h2>
        <pre><code>{'chili --version\nchili --model fake "hello"'}</code></pre>
        <p>第二条是本地安装检查，不调用在线模型、不需要 API Key。若提示找不到 <code>chili</code>，重新打开终端，或按安装器提示把安装目录加入 PATH。</p>
        <p>更新时重新运行安装命令。固定版本：<code>CHILI_VERSION={cliVersion} sh install.sh</code>（先保存脚本）。卸载时移除 <code>~/.local/bin/chili</code>；项目会话和个人配置会保留。</p>
      </section>
      <section className="download-install" aria-labelledby="assets-heading">
        <h2 id="assets-heading">手动下载 · v{cliVersion}</h2>
        <div className="download-assets">
          {[['darwin-arm64', 'macOS · Apple Silicon'], ['linux-arm64', 'Linux · arm64'], ['linux-x64', 'Linux · x64']].map(([target, label]) => <a key={target} href={`https://github.com/ponyfly6/chili/releases/download/v${cliVersion}/chili-${cliVersion}-${target}.tar.gz`}>{label}<span>tar.gz ↗</span></a>)}
        </div>
        <p><a href={`https://github.com/ponyfly6/chili/releases/download/v${cliVersion}/SHA256SUMS`}>SHA-256 校验文件</a> · <a href={releaseUrl}>发布说明与源代码</a></p>
        <p className="download-note">CLI 为开发预览；macOS 二进制尚未进行 Developer ID 公证。请保留工作副本，并查看每次操作的工具审核提示。</p>
      </section>
    </main>
    <footer className="site-footer shell"><a className="brand" href="/">chili</a><span>给想法，一点行动力。</span><a href="https://github.com/ponyfly6/chili">GitHub ↗</a></footer>
  </>;
}
