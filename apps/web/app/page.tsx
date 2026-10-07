"use client";

import { useState } from "react";

const githubUrl = "https://github.com/ponyfly6/chili";
const sourceCommand = `git clone https://github.com/ponyfly6/chili.git
cd chili
bun install
bun run desktop`;

const examples = [
  {
    label: "做一个网站",
    title: "周末出走计划",
    prompt: "帮我做一个周末旅行网站。想要清爽一点，有山野的感觉。",
    response: "首页已经做好了。路线、行程和出发前要准备的东西，都放在一起了。",
    file: "weekend.html",
    edit: "文字再轻松一点，像朋友在邀请我出门。",
    revised: "文案改好了，保留了原来的路线和行程。看看现在是不是更像你想要的感觉。",
  },
  {
    label: "整理一份研究",
    title: "咖啡店开店研究",
    prompt: "我想开一家小咖啡店。把这些调研资料整理成一份能用的选址对比。",
    response: "已按客流、租金和周边环境整理成对比报告，待确认的资料也单独列出来了。",
    file: "location-research.md",
    edit: "先把最需要实地确认的事情放在前面。",
    revised: "实地考察清单已放到开头，可以带着它去看场地了。",
  },
  {
    label: "改进现有项目",
    title: "作品集的一次更新",
    prompt: "帮我整理作品集首页，让人一进来就能看到最近的三个作品。",
    response: "最新作品已经放到首页，介绍也精简了。你可以先看看整体顺序。",
    file: "portfolio.html",
    edit: "把品牌设计放在最前面，它最能代表我。",
    revised: "顺序已调整，品牌设计现在是第一个作品。",
  },
];

function ResultPreview({ selected, revised }: { selected: number; revised: boolean }) {
  if (selected === 1) {
    return (
      <div className="report-result">
        <div className="result-eyebrow">FIELD NOTES / 2026</div>
        <h3>{revised ? "先去现场，看看这几件事。" : "一间咖啡店，\n从选对街角开始。"}</h3>
        <p>咖啡店选址研究 · 工作草稿</p>
        <div className="report-rule" />
        <div className="report-row"><b>01</b><span>{revised ? "工作日与周末，各观察一次客流" : "街区与客流"}</span><small>待实地确认</small></div>
        <div className="report-row"><b>02</b><span>{revised ? "询问租金、转让费与合同条件" : "租金与固定成本"}</span><small>待补充资料</small></div>
        <div className="report-row"><b>03</b><span>{revised ? "走访附近店铺，了解主要客群" : "周边店铺与客群"}</span><small>考察清单</small></div>
        <div className="report-foot">把零散资料，变成下一步。</div>
      </div>
    );
  }
  if (selected === 2) {
    return (
      <div className="portfolio-result">
        <div className="portfolio-nav"><b>Lin.</b><span>DESIGN & EVERYDAY</span></div>
        <h3>一些想法，<br />一些认真做的事。</h3>
        <p>Selected work — 2026</p>
        <div className="portfolio-grid">
          <div className="portfolio-work primary-work" style={{ order: revised ? 0 : 1 }}><span>0{revised ? "1" : "2"}</span><strong>有间<br />茶室</strong><small>品牌设计 / IDENTITIES</small></div>
          <div className="portfolio-work second-work" style={{ order: revised ? 1 : 0 }}><span>0{revised ? "2" : "1"}</span><strong>好好<br />生活。</strong><small>编辑设计 / EDITORIAL</small></div>
        </div>
      </div>
    );
  }
  return (
    <div className={`weekend-result ${revised ? "is-revised" : ""}`}>
      <div className="weekend-nav"><b>OUTSIDE</b><span>周末，去外面。</span><span className="weekend-menu">路线 / 关于</span></div>
      <div className="weekend-main">
        <div className="result-eyebrow">LESS SCROLLING. MORE WANDERING.</div>
        <h3>{revised ? <>走吧，<br />去吹吹风。</> : <>周末，<br />留给山野。</>}</h3>
        <p>{revised ? "不用等一个长假。带上好心情，我们周末见。" : "两天，一条小路。把日常留在身后。"}</p>
        <span className="weekend-label">找到你的周末</span>
        <div className="weekend-type" aria-hidden="true">out<br />side.</div>
      </div>
      <div className="weekend-bottom"><span>01 / 山野漫步</span><span>02 / 湖边放空</span><span>03 / 小城闲逛</span></div>
    </div>
  );
}

export default function Home() {
  const [selected, setSelected] = useState(0);
  const [revised, setRevised] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [mobileAnswer, setMobileAnswer] = useState<"day" | "night" | null>(null);
  const current = examples[selected];

  async function copySourceCommand() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(sourceCommand);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2200);
  }

  return (
    <>
      <a className="skip-link" href="#main">跳到主要内容</a>
      <header className="site-header shell">
        <a className="brand" href="#top" aria-label="Chili 首页"><img src="/chili-icon.svg" width="36" height="36" alt="" /><span>chili</span><span className="brand-name">辣椒</span></a>
        <nav aria-label="主导航"><a href="#experience">体验</a><a href="#mobile">手机连接</a><a href="#personal">个人代理 <span className="nav-soon">即将探索</span></a></nav>
        <a className="nav-action" href="#start">认识 Chili <span className="small-pepper" aria-hidden="true">✳</span></a>
      </header>

      <main id="main">
        <section className="hero shell" id="top">
          <div className="eyebrow"><span className="tiny-mark" aria-hidden="true">✳</span> YOUR IDEAS. A LITTLE HEAT.</div>
          <h1>你的想法，<br />有了<span className="action-word">行动派<svg viewBox="0 0 320 16" aria-hidden="true"><path d="M4 10 Q140 -1 314 7" /></svg></span>。</h1>
          <p className="hero-description">认识 Chili，为你做事的个人 AI。<br />把需求变成成果，用一句话继续改。</p>
          <div className="hero-actions"><a className="button button-primary" href="#experience">看看 Chili 怎么做 <span className="play-icon" aria-hidden="true">▶</span></a><a className="text-link" href="#personal">遇见未来的个人代理</a></div>
          <div className="hero-meta"><span>本地优先</span><span>开放源码</span><span>开发预览</span></div>
          <div className="hero-margin-note" aria-hidden="true">A little chili.<br />A lot of possibility.</div>
        </section>

        <section className="experience shell" id="experience" aria-labelledby="experience-heading">
          <div className="demo-toolbar"><h2 id="experience-heading">从一句话开始。</h2><div className="scenario-tabs" role="tablist" aria-label="选择演示场景">{examples.map((example, index) => <button key={example.label} id={`scenario-${index}`} type="button" role="tab" aria-selected={selected === index} aria-controls="demo-panel" tabIndex={selected === index ? 0 : -1} onKeyDown={(event) => {
                const next = event.key === "ArrowRight" ? (index + 1) % examples.length : event.key === "ArrowLeft" ? (index + examples.length - 1) % examples.length : event.key === "Home" ? 0 : event.key === "End" ? examples.length - 1 : null;
                if (next === null) return;
                event.preventDefault();
                setSelected(next);
                setRevised(false);
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#scenario-${next}`)?.focus();
              }} onClick={() => { setSelected(index); setRevised(false); }}>{example.label}</button>)}</div></div>
          <div className="desktop-demo" id="demo-panel" role="tabpanel" aria-labelledby={`scenario-${selected}`}>
            <aside className="demo-sidebar" aria-label="演示中的项目列表">
              <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
              <div className="demo-brand"><img src="/chili-icon.svg" alt="" width="28" height="28" />chili</div>
              <div className="sidebar-caption">你的空间</div>
              <div className="sidebar-project active"><span aria-hidden="true">▤</span> 我的创作</div>
              <div className="sidebar-task">{current.title}</div>
              <div className="sidebar-project"><span aria-hidden="true">▤</span> 工作与灵感</div>
              <div className="sidebar-bottom"><span className="avatar">Y</span><span>我的工作空间<small>本地项目</small></span></div>
            </aside>
            <div className="demo-conversation">
              <div className="conversation-heading"><span>{current.title}</span><span className="demo-caption">交互演示</span></div>
              <div className="conversation-content">
                <div className="user-bubble">{current.prompt}</div>
                <div className="assistant-label"><img src="/chili-icon.svg" alt="" width="24" height="24" /><b>Chili</b></div>
                <div className="process-line"><span aria-hidden="true">✓</span> 整理需求，完成第一版</div>
                <p className="assistant-response">{revised ? current.revised : current.response}</p>
                <div className="file-chip"><span aria-hidden="true">▧</span><span>{current.file}<small>{revised ? "已按你的想法更新" : "第一版已准备好"}</small></span><span className="file-tick" aria-hidden="true">✓</span></div>
                {revised && <div className="revision-note"><span aria-hidden="true">✓</span> {current.edit}</div>}
              </div>
              <div className="demo-composer"><span>试着继续改一改</span><button type="button" onClick={() => setRevised(!revised)} aria-pressed={revised}>{revised ? "看看修改前" : current.edit}<span aria-hidden="true">↵</span></button></div>
            </div>
            <div className="demo-result"><div className="result-topbar"><span className="result-selected">成果</span><span>{current.file}</span><span className="preview-mark">预览</span></div><div className="result-content" aria-live="polite"><ResultPreview selected={selected} revised={revised} /></div><div className="result-bottom"><span>想法有了可以看见的样子。</span><span>{revised ? "已修改" : "第一版"}</span></div></div>
          </div>
          <p className="demo-footnote">示例内容用于演示工作方式。实际结果由你选择的模型、工具和任务决定。</p>
        </section>

        <section className="promise-section shell">
          <div className="section-kicker">从想法，到你满意的样子</div>
          <div className="promise-heading"><h2>你说想要什么。<br />Chili 动手去做。</h2><p>一个网页，一份研究，一个一直想改好的项目。<br />交代目标，看见结果，继续聊下去。</p></div>
          <div className="steps-grid">
            <article><span className="step-number">01</span><h3>从你的需求出发</h3><p>用平常说话的方式交代目标和偏好，让 Chili 理解这件事。</p></article>
            <article><span className="step-number">02</span><h3>把过程交给它</h3><p>读取资料、使用工具、组织分工。你可以随时查看进展、补充想法。</p></article>
            <article><span className="step-number">03</span><h3>让结果继续变好</h3><p>打开生成的页面、报告和文件。说出哪里要改，在原来的工作上继续。</p></article>
          </div>
        </section>

        <section className="mobile-section" id="mobile">
          <div className="mobile-inner shell">
            <div className="mobile-copy"><div className="section-kicker">CHILI，跟得上你的节奏 <span className="status-badge">移动端 · 开发预览</span></div><h2>换个地方，<br />接着聊。</h2><p>电脑上开始的工作，手机上接着关心。<br />看看进展，补充一句想法，<br />回答一个需要你决定的问题。</p><div className="mobile-flow"><span>电脑上执行</span><span aria-hidden="true">—</span><span>手机上接续</span></div><p className="availability-note">当前在可信私网内验证，电脑需要保持运行。<br />App 与连接恢复正在开发，尚未公开发布。</p></div>
            <div className="mobile-stage">
              <div className="context-note"><span className="note-symbol" aria-hidden="true">✳</span><div><b>你的想法，不用等回到电脑前。</b><span>同一项工作，接着往前。</span></div></div>
              <div className="phone-demo">
                <div className="phone-status"><span>9:41</span><span aria-hidden="true">▰ ▰</span></div>
                <div className="phone-header"><img src="/chili-icon.svg" width="28" height="28" alt="" /><b>Chili</b><span>界面示意</span></div>
                <div className="phone-task"><span>我的创作</span><h3>周末出走计划</h3><p>在你的电脑上</p></div>
                <div className="phone-message"><span className="phone-message-label">Chili</span><p>{mobileAnswer === "night" ? "收到，我会按两天一夜来安排，保留轻松一点的节奏。" : mobileAnswer === "day" ? "好，我会挑一条适合当天往返的路线，给回程留出充足时间。" : "路线初稿准备好了。你更想当天往返，还是在山里住一晚？"}</p></div>
                <div className="phone-choices"><button type="button" aria-pressed={mobileAnswer === "day"} onClick={() => setMobileAnswer("day")}>当天往返</button><button type="button" aria-pressed={mobileAnswer === "night"} onClick={() => setMobileAnswer("night")}>住一晚，慢慢来</button></div>
                <div className="phone-outcome" aria-live="polite">{mobileAnswer ? "你的选择已加入演示" : "点一个选项，试试接续对话"}</div>
                <div className="phone-input">补充你的想法…<span aria-hidden="true">＋</span></div>
                <div className="phone-home" aria-hidden="true" />
              </div>
              <span className="mobile-stage-label">WORK MOVES. SO DO YOU.</span>
            </div>
          </div>
        </section>

        <section className="personal-section shell" id="personal">
          <div className="personal-intro"><div className="section-kicker">接下来，走得更远 <span className="status-badge">个人代理 · 规划中</span></div><h2>一个越来越<br /><span>了解你的 Chili。</span></h2><p>我们正在探索个人代理的下一步：<br />记住你在意的事，跟进交代过的工作，<br />在需要你时，带着进展来找你。</p><div className="personal-signature"><img src="/chili-icon.svg" width="72" height="72" alt="Chili 辣椒标识" /><span>Your own little spark.</span></div></div>
          <div className="future-notes">
            <article className="future-note"><span className="future-index">01 / 记住偏好</span><h3>“以后，按我的习惯来。”</h3><p>让你明确告诉它的偏好、项目背景和重要决定，成为下一次工作的起点。</p></article>
            <article className="future-note"><span className="future-index">02 / 持续跟进</span><h3>“这件事，你继续帮我盯着。”</h3><p>围绕你交代的事情跟踪变化，准备下一步，把需要关注的进展带回来。</p></article>
            <article className="future-note"><span className="future-index">03 / 适时找你</span><h3>“需要我决定的时候，告诉我。”</h3><p>让日常工作有序推进，把真正需要你判断的问题，清楚地交到你面前。</p></article>
            <p className="future-disclaimer">以上为产品方向预告，持续跟进与主动提醒尚未上线。</p>
          </div>
        </section>

        <section className="your-way shell" id="your-way"><div className="section-kicker">为你的工作方式留出空间</div><h2>你的项目。你的选择。</h2><div className="principles-grid"><article><span className="principle-icon" aria-hidden="true">⌂</span><h3>从自己的电脑开始</h3><p>项目文件、会话与成果保存在本地。调用在线模型和外部工具时，会发送完成任务所需的内容。</p></article><article><span className="principle-icon" aria-hidden="true">✳</span><h3>选择适合你的模型</h3><p>连接你已有的模型服务，根据任务和自己的偏好选择，不把工作方式绑定在一个模型上。</p></article><article><span className="principle-icon" aria-hidden="true">＋</span><h3>把熟悉的工具带进来</h3><p>通过 Skills 和 MCP 扩展工作能力，把常用的方法和工具接入 Chili。</p></article></div><div className="provider-line"><span>连接你选择的服务</span><b>OpenAI</b><b>MiniMax</b><b>DeepSeek</b><b>Kimi</b><b>更多模型</b></div></section>

        <section className="start-section" id="start"><div className="start-inner shell"><div><div className="section-kicker">一点热情，开始行动。</div><h2>下一件想做的事，<br />交给 Chili。</h2><p>Chili 正在成长。先认识它，也欢迎一起把它做好。</p><div className="start-actions"><a className="button button-light" href={githubUrl} target="_blank" rel="noreferrer">在 GitHub 关注 Chili</a><a className="light-link" href="#experience">再看一次演示</a></div><p className="start-note">开源 · 开发预览 · 桌面正式安装包尚未发布</p></div><div className="source-card"><div><span>喜欢自己动手？</span><button type="button" onClick={copySourceCommand}>{copyState === "copied" ? "已复制" : copyState === "failed" ? "请手动复制" : "复制命令"}</button></div><pre><code>{sourceCommand}</code></pre><p>源码运行需安装 Bun，并配置模型服务。</p><span className="sr-only" role="status">{copyState === "copied" ? "启动命令已复制" : copyState === "failed" ? "复制失败，请手动选择命令" : ""}</span></div></div></section>
      </main>
      <footer className="site-footer shell"><a className="brand" href="#top"><img src="/chili-icon.svg" width="30" height="30" alt="" /><span>chili</span></a><span>给想法，一点行动力。</span><div><a href={`${githubUrl}/blob/dev/README.md`} target="_blank" rel="noreferrer">文档</a><a href={githubUrl} target="_blank" rel="noreferrer">GitHub</a><span>Apache-2.0</span></div></footer>
    </>
  );
}
