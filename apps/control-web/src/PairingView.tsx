import type { FormEvent, ReactNode } from "react";
import chiliIcon from "../../../assets/brand/chili-icon.svg";
import "./pairing.css";

export interface PairingViewProps {
  native: boolean;
  booting: boolean;
  storageReady: boolean;
  pairingStatus: "creating_identity" | "waiting_for_desktop" | "approved" | null;
  connectionLabel: string;
  connection: string;
  computerAddress: string;
  onComputerAddressChange: (value: string) => void;
  deviceLabel: string;
  onDeviceLabelChange: (value: string) => void;
  pairingCode: string;
  onPairingCodeChange: (value: string) => void;
  recoverableAddress: string | null;
  onPair: (event: FormEvent<HTMLFormElement>) => void;
  onReconnect: () => void;
  onForget: () => void;
  alerts?: ReactNode;
}

export function PairingView({
  native,
  booting,
  storageReady,
  pairingStatus,
  connectionLabel,
  connection,
  computerAddress,
  onComputerAddressChange,
  deviceLabel,
  onDeviceLabelChange,
  pairingCode,
  onPairingCodeChange,
  recoverableAddress,
  onPair,
  onReconnect,
  onForget,
  alerts,
}: PairingViewProps) {
  const awaitingConfirmation = pairingStatus === "waiting_for_desktop";
  const approved = pairingStatus === "approved";
  const showPending = awaitingConfirmation || approved;
  const expired = connection === "expired";
  const showRecovery = native && recoverableAddress !== null && !expired;
  const recovering = connection === "restoring" || connection === "reconnecting";
  const fieldsDisabled = booting || Boolean(pairingStatus);
  const submitDisabled = fieldsDisabled || !storageReady || !deviceLabel.trim() || !pairingCode.trim() || (native && !computerAddress.trim());

  return <div className="pairing-view">
    <header className="pairing-view-header">
      <div className="pairing-view-brand" aria-label="Chili">
        <img src={chiliIcon} alt="" width="32" height="32" />
        <span>Chili</span>
      </div>
      <div className="pairing-view-connection" role="status" data-testid="connection-status">
        <span className={`pairing-view-status-dot${expired ? " pairing-view-status-dot-expired" : ""}${booting || pairingStatus || recovering ? " pairing-view-status-dot-busy" : ""}`} aria-hidden="true" />
        <span>{booting && !recovering ? "正在读取本机记录…" : connectionLabel}</span>
      </div>
    </header>

    <main className="pairing-view-main">
      <div className="pairing-view-hero">
        <div className="pairing-view-computer" aria-hidden="true"><ComputerIcon /></div>
        <h1>把电脑上的工作<br />带在身边。</h1>
        <p>{showRecovery ? "重新连接你的电脑，接着上次的工作。" : <>在电脑 Chili 中打开“手机连接”，<br />获取{native ? "连接地址和" : ""}一次性配对码。</>}</p>
      </div>

      {alerts ? <div className="pairing-view-alerts">{alerts}</div> : null}

      {expired ? <section className="pairing-view-expired" aria-labelledby="pairing-expired-heading">
        <span className="pairing-view-state-icon" aria-hidden="true"><ShieldIcon /></span>
        <div><h2 id="pairing-expired-heading">需要重新配对</h2><p>原电脑授权已失效或被撤销。请回电脑生成新配对码，再确认这台手机。</p></div>
      </section> : null}

      {showRecovery ? <section className="pairing-view-recovery" aria-labelledby="pairing-recovery-heading">
        <span className="pairing-view-card-kicker">已保存的电脑</span>
        <h2 id="pairing-recovery-heading">{recovering ? "正在恢复连接" : "接着上次的工作"}</h2>
        <p className="pairing-view-address">{recoverableAddress}</p>
        <p className="pairing-view-card-description">保持电脑上的 Chili 运行，并确认手机能访问这台电脑。</p>
        <button type="button" className="pairing-view-submit" data-testid="resume-device" onClick={onReconnect} disabled={booting || !storageReady || recovering}>
          {recovering ? <><span className="pairing-view-spinner" aria-hidden="true" />正在连接…</> : <>重新连接<ArrowIcon /></>}
        </button>
        <button type="button" className="pairing-view-text-button" data-testid="forget-device" onClick={onForget} disabled={booting || recovering}>忘记这台电脑，重新配对</button>
      </section> : <>
        <ol className="pairing-view-steps" aria-label="连接步骤">
          <li className={showPending ? "pairing-view-step-complete" : "pairing-view-step-current"} aria-current={showPending ? undefined : "step"}>
            <span aria-hidden="true">{showPending ? <CheckIcon /> : "1"}</span>填写连接信息
          </li>
          <li className={showPending ? "pairing-view-step-current" : ""} aria-current={showPending ? "step" : undefined}>
            <span aria-hidden="true">2</span>电脑确认
          </li>
        </ol>

        <form className={`pairing-view-form${showPending ? " pairing-view-form-pending" : ""}`} onSubmit={onPair} aria-label="配对你的手机" aria-busy={Boolean(pairingStatus)}>
          {showPending ? <section className="pairing-view-pending" role="status" data-testid={awaitingConfirmation ? "pairing-wait" : "pairing-approved"} aria-labelledby="pairing-pending-heading">
            <div className="pairing-view-waiting-icon" aria-hidden="true">{approved ? <CheckIcon /> : <ComputerIcon />}</div>
            <h2 id="pairing-pending-heading">{approved ? "确认完成，正在连接" : "在电脑上确认一下"}</h2>
            <p>{approved ? "电脑已确认本次配对，正在建立加密连接。" : <>配对请求已发出。<br />请在电脑上核对设备名称并确认。</>}</p>
            <dl className="pairing-view-pending-details">
              <div><dt>设备名称</dt><dd>{deviceLabel}</dd></div>
              <div><dt>权限范围</dt><dd>当前项目的任务</dd></div>
            </dl>
            {!approved ? <p className="pairing-view-pending-note">确认后，就可以查看进展、回答问题和补充指令。</p> : null}
          </section> : null}

          <div className="pairing-view-fields" hidden={showPending}>
            {native ? <div className="pairing-view-field">
              <label htmlFor="computer-address">电脑连接地址</label>
              <input id="computer-address" name="computer-address" data-testid="computer-address" type="url" inputMode="url" value={computerAddress} onChange={(event) => onComputerAddressChange(event.target.value)} placeholder="https://你的电脑地址:端口" autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={fieldsDisabled} aria-describedby="pairing-address-hint" />
              <p id="pairing-address-hint" className="pairing-view-field-hint">填写电脑显示的 HTTPS 地址。</p>
            </div> : null}
            <div className="pairing-view-field">
              <label htmlFor="device-label">设备名称</label>
              <input id="device-label" name="device-label" data-testid="device-label" value={deviceLabel} onChange={(event) => onDeviceLabelChange(event.target.value)} maxLength={64} autoComplete="off" spellCheck={false} required disabled={fieldsDisabled} aria-describedby="pairing-device-hint" />
              <p id="pairing-device-hint" className="pairing-view-field-hint">显示在电脑上，方便确认是你的手机。</p>
            </div>
            <div className="pairing-view-field">
              <label htmlFor="pairing-code">一次性配对码</label>
              <input id="pairing-code" name="pairing-code" className="pairing-view-code" data-testid="pairing-code" value={pairingCode} onChange={(event) => onPairingCodeChange(event.target.value)} placeholder="输入电脑显示的配对码" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={64} required disabled={fieldsDisabled} />
            </div>
          </div>

          <button className="pairing-view-submit" type="submit" data-testid="pair-submit" disabled={submitDisabled}>
            {pairingStatus ? <><span className="pairing-view-spinner" aria-hidden="true" />{approved ? "正在建立加密连接…" : awaitingConfirmation ? "等待电脑确认…" : "正在准备连接…"}</> : <>连接电脑<ArrowIcon /></>}
          </button>
        </form>
      </>}

      <details className="pairing-view-help">
        <summary>连接前需要准备什么？<span aria-hidden="true"><ChevronIcon /></span></summary>
        <p>保持电脑上的 Chili 运行，在“手机连接”中开启连接。手机与电脑需要处于可互通的私网。</p>
        <p>首次连接需使用手机信任的 HTTPS 证书。输入电脑生成的配对码后，再回电脑核对设备名称并确认。</p>
        <p>连接使用端到端加密，授权仅限电脑当前项目的任务。</p>
      </details>

      <div className="pairing-view-retention" data-testid="refresh-warning">
        <ShieldIcon />
        <p><strong>{native ? "下次打开，接着连接" : "刷新后需要重新配对"}</strong><span>{native ? "授权有效时，重新打开 App 会自动连接。电脑重启、切换项目或撤销授权后，需要重新配对。" : "浏览器不保存连接授权。刷新或关闭页面后需重新配对；待核对的指令提醒会保留。"}</span></p>
      </div>
    </main>
  </div>;
}

function ComputerIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="3.5" width="16" height="12" rx="2" /><path d="M2 19h20M9 15.5l-1 3.5m7-3.5 1 3.5" /></svg>;
}

function ShieldIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 7 3v5c0 4.7-2.5 7.8-7 10-4.5-2.2-7-5.3-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>;
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>;
}

function CheckIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>;
}
