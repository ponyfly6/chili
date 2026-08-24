"use client";

import { useState } from "react";

const githubUrl = "https://github.com/ponyfly6/chili";
const sourceCommand = `git clone https://github.com/ponyfly6/chili.git
cd chili
bun install
MINIMAX_API_KEY=... bun run chili -- "总结这个仓库"`;

const capabilities = [
  {
    index: "01",
    title: "进入真实代码库",
    body: "探索文件与依赖，读取项目规则，调用结构化工具。Chili 的工作现场就是你的仓库。",
    detail: "READ · GLOB · GREP",
    tone: "red",
  },
  {
    index: "02",
    title: "从建议走到执行",
    body: "编辑文件、应用 patch、运行 Shell，再用测试与构建验证结果。每一步都留下可追踪的上下文。",
    detail: "EDIT · PATCH · BASH",
    tone: "mint",
  },
  {
    index: "03",
    title: "权限边界看得见",
    body: "敏感动作进入审批流程。你可以逐次放行，也可以为当前 session 保留明确授权。",
    detail: "APPROVAL · POLICY",
    tone: "blue",
  },
  {
    index: "04",
    title: "任务可以接着做",
    body: "Session 可查看、恢复与继续。被打断的工作不会变成一段找不回来的聊天记录。",
    detail: "SAVE · RESUME",
    tone: "yellow",
  },
  {
    index: "05",
    title: "按需加载 Skills",
    body: "用户级与仓库级 Skills 把可复用流程带进每次任务，Prompt 上下文也可以被检查。",
    detail: "$SKILL · CONTEXT",
    tone: "violet",
  },
  {
    index: "06",
    title: "一个 Runtime，多种入口",
    body: "CLI 适合快速调用，TUI 适合持续协作；模型、工具、MCP 与事件存储共享同一套运行时。",
    detail: "CLI · TUI · SDK",
    tone: "green",
  },
];

const workflow = [
  ["01", "交代目标", "在仓库里直接描述要完成的结果，而不是先拆成一长串机械步骤。"],
  ["02", "观察行动", "Chili 探索上下文、调用工具、拆分任务；需要越过权限边界时会停下来询问。"],
  ["03", "拿到结果", "修改、验证与关键决定留在同一条 session；下次可以从这里继续。"],
];

const providers = ["MiniMax", "DeepSeek", "Kimi", "ChatGPT Codex", "Responses API", "MCP", "Skills"];

export default function Home() {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copySourceCommand() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(sourceCommand);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <>
      <header className="site-header shell">
        <a className="brand" href="#top" aria-label="Chili 首页">
          <img src="/chili-icon.svg" alt="" width="34" height="34" />
          <span>Chili</span>
          <span className="brand-cn">辣椒</span>
        </a>
        <nav aria-label="主导航">
          <a href="#capabilities">能力</a>
          <a href="#workflow">工作方式</a>
          <a href="#start">开始</a>
          <a className="nav-github" href={githubUrl} target="_blank" rel="noreferrer">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>

      <main>
      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span /> EXPERIMENTAL · OPEN SOURCE</div>
          <h1>
            不止聊天。
            <span>进仓库，把事情做完。</span>
          </h1>
          <p>
            Chili 是一个本地运行、终端优先的 coding agent。它会探索仓库、调用工具、编辑文件、执行命令，让任务在可控、可恢复的 session 中持续推进。
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#start">从源码运行 <span aria-hidden="true">→</span></a>
            <a className="button button-secondary" href={githubUrl} target="_blank" rel="noreferrer">查看 GitHub <span aria-hidden="true">↗</span></a>
          </div>
          <div className="hero-note"><span className="status-dot" />早期开发中，API 与行为可能变化</div>
        </div>

        <figure className="terminal-wrap" aria-labelledby="terminal-demo-caption">
          <div className="terminal-glow" aria-hidden="true" />
          <div className="terminal" aria-hidden="true">
            <div className="terminal-bar">
              <div className="terminal-dots" aria-hidden="true"><i /><i /><i /></div>
              <span>chili · ~/code/your-project</span>
              <span className="terminal-live"><b /> LOCAL</span>
            </div>
            <div className="terminal-body">
              <div className="terminal-brandline">
                <img src="/chili-icon.svg" alt="" width="44" height="44" />
                <div><strong>Chili</strong><span>coding agent runtime</span></div>
              </div>
              <div className="prompt-line"><span className="prompt">❯</span> 修复支付回调的重试问题，并补上测试</div>
              <div className="agent-line muted"><span>◆</span> 正在探索仓库结构</div>
              <div className="tool-line"><span className="tool-ok">✓</span><code>rg &quot;payment.*retry&quot; apps packages</code><small>42ms</small></div>
              <div className="tool-line"><span className="tool-ok">✓</span><code>read packages/core/src/retry.ts</code><small>6ms</small></div>
              <div className="agent-card">
                <div className="agent-card-head"><span><i /> 并行任务</span><b>2 running</b></div>
                <div className="task-row"><span className="task-branch">├─</span><span>定位失败路径</span><em>working</em></div>
                <div className="task-row"><span className="task-branch">└─</span><span>设计回归测试</span><em>working</em></div>
              </div>
              <div className="terminal-summary"><span className="tool-ok">✓</span> 已更新 2 个文件 · 8 项测试通过<span className="cursor" /></div>
            </div>
            <div className="terminal-footer"><span><b>selected model</b> · medium</span><span>main <i>●</i> 1 task</span></div>
          </div>
          <figcaption className="demo-label" id="terminal-demo-caption">Chili 终端界面演示</figcaption>
        </figure>
      </section>

      <div className="signal-band" aria-label="Chili 特性概览">
        <div className="signal-track shell">
          {["本地运行", "终端优先", "权限可控", "会话可恢复", "多模型连接", "Apache-2.0"].map((item) => (
            <span key={item}>{item}<i aria-hidden="true">✦</i></span>
          ))}
        </div>
      </div>

      <section className="manifesto shell" id="capabilities">
        <div className="section-kicker"><span>01</span> WHY CHILI</div>
        <div className="manifesto-grid">
          <h2>答案很便宜。<br /><em>行动</em>才有温度。</h2>
          <div className="manifesto-copy">
            <p>Chili 不是给代码建议后就离开的聊天框。它进入真实项目，在工具、权限与验证构成的边界里推进任务。</p>
            <p>名字来自辣椒，也来自火：直接、醒神、持续燃烧。让一个模糊目标，变成仓库里真实发生的改变。</p>
          </div>
        </div>

        <div className="capability-grid">
          {capabilities.map((item) => (
            <article className={`capability-card tone-${item.tone}`} key={item.index}>
              <div className="card-top"><span>{item.index}</span><i aria-hidden="true" /></div>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              <code>{item.detail}</code>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-section" id="workflow">
        <div className="workflow shell">
          <div className="workflow-intro">
            <div className="section-kicker"><span>02</span> HOW IT WORKS</div>
            <h2>把目标交给 Chili。<br />过程仍在你手里。</h2>
            <p>少一点仪式，多一点可见的推进。你始终知道它正在做什么、为什么停下来，以及下一步会发生什么。</p>
          </div>
          <ol className="workflow-steps">
            {workflow.map(([index, title, body]) => (
              <li key={index}>
                <span className="step-number">{index}</span>
                <div><h3>{title}</h3><p>{body}</p></div>
                <span className="step-arrow" aria-hidden="true">↘</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="runtime shell">
        <div className="section-kicker"><span>03</span> ONE RUNTIME</div>
        <div className="runtime-head">
          <h2>选你的入口，<br />不换一套大脑。</h2>
          <p>从一句 CLI 到持续工作的 TUI，Chili 让模型连接、Skills、MCP、工具与 session 共享一致的运行时边界。</p>
        </div>
        <div className="runtime-window">
          <div className="runtime-rail">
            <span className="active">CLI</span><span>TUI</span><span>SDK</span>
            <i />
            <small>CHILI RUNTIME</small>
          </div>
          <div className="runtime-code">
            <span className="code-comment"># 一次快速任务</span>
            <code><b>$</b> bun run chili -- &quot;总结这个仓库&quot;</code>
            <span className="code-comment"># 回到保存的工作现场</span>
            <code><b>$</b> bun run chili -- --resume &lt;session-id&gt; &quot;继续&quot;</code>
          </div>
          <div className="runtime-state">
            <span>SESSION</span><b>resumable</b>
            <span>TOOLS</span><b>structured</b>
            <span>POLICY</span><b>explicit</b>
          </div>
        </div>
        <div className="provider-row">
          <p>连接你需要的模型与工具</p>
          <div>{providers.map((provider) => <span key={provider}>{provider}</span>)}</div>
        </div>
      </section>

      <section className="origin-section">
        <div className="origin shell">
          <div className="origin-mark" aria-hidden="true"><img src="/chili-icon.svg" alt="" /></div>
          <div className="origin-copy">
            <div className="section-kicker"><span>04</span> THE NAME</div>
            <blockquote>“把事情做热起来。”</blockquote>
            <p>Chili 是辣椒，也是行动、速度和持续燃烧的能量。它适合一个终端里的 agent：反应快，敢推进，同时保持本地、可控、可恢复。</p>
          </div>
        </div>
      </section>

      <section className="start shell" id="start">
        <div className="start-copy">
          <div className="section-kicker"><span>05</span> GET STARTED</div>
          <h2>从你的仓库开始。</h2>
          <p>Chili 目前处于早期开发阶段，请从源码运行。需要 Bun 1.3.14 与一个已配置的模型连接。</p>
          <a href={githubUrl} target="_blank" rel="noreferrer">阅读项目说明 <span aria-hidden="true">↗</span></a>
        </div>
        <div className="install-card">
          <div className="install-bar">
            <span><i /> SOURCE SETUP</span>
            <button type="button" onClick={copySourceCommand} aria-live="polite">
              {copyState === "copied" ? "已复制 ✓" : copyState === "failed" ? "复制失败" : "复制命令"}
            </button>
          </div>
          <pre><code><span>git clone</span> https://github.com/ponyfly6/chili.git{"\n"}<span>cd</span> chili{"\n"}<span>bun install</span>{"\n"}<b>MINIMAX_API_KEY</b>=... bun run chili -- <em>&quot;总结这个仓库&quot;</em></code></pre>
          <div className="install-note"><span>!</span> Experimental · 暂无稳定公开 API</div>
        </div>
      </section>
      </main>

      <footer className="footer shell">
        <div className="footer-brand"><img src="/chili-icon.svg" alt="" /><span><b>Chili</b><small>把代码库做热起来。</small></span></div>
        <div className="footer-links"><a href={githubUrl} target="_blank" rel="noreferrer">GitHub ↗</a><a href={`${githubUrl}#readme`} target="_blank" rel="noreferrer">README ↗</a></div>
        <p>Apache-2.0 · Built with fire in the terminal.</p>
      </footer>
    </>
  );
}
