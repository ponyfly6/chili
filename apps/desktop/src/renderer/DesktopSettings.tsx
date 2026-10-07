import { useState, type ReactNode } from "react";
import type { DelegationPolicy, RuntimeModelDescriptor, RuntimePermissionProfileId } from "@chili/protocol";
import type { DesktopSessionConfig } from "../shared/contracts.js";
import type { DesktopTheme } from "./theme.js";
import { RemoteControlPanel } from "./RemoteControlPanel.js";
import { settingsPages, type ReadingPreferences, type SettingsPage } from "./conversation-design.js";
import {
  availableReasoningLevels, availableServiceTiers, canSelectProviderDefault, createSessionModelSettingsDraft,
  modelKey, reconcileSessionModelSettingsModel, validateSessionModelSettingsDraft,
  type ReasoningSelection, type ServiceTierSelection, type SessionModelSettingsDraft,
} from "./task-console-model.js";

export interface SessionSettingsValues extends SessionModelSettingsDraft {
  permissionProfile: RuntimePermissionProfileId;
  reviewInstructions: string;
  reviewerModelKey: string;
  delegationPolicy: DelegationPolicy;
}

export function DesktopSettings({ page, onPage, project, session, config, models, disabled, busy, error,
  theme, onTheme, themeSaveFailed, themeSaving, preferences, onPreferences, preferenceSaveFailed,
  onSave, onReloadMcp, onPrompt, onClose, onNewSession,
}: {
  page: SettingsPage; onPage: (page: SettingsPage) => void; project: string; session: string | undefined;
  config: DesktopSessionConfig | undefined; models: readonly RuntimeModelDescriptor[]; disabled: boolean; error: string | undefined;
  busy: boolean;
  theme: DesktopTheme; onTheme: (theme: DesktopTheme) => void; themeSaveFailed: boolean; themeSaving: boolean;
  preferences: ReadingPreferences; onPreferences: (value: ReadingPreferences) => void; preferenceSaveFailed: boolean;
  onSave: (values: SessionSettingsValues, section: "models" | "permissions") => void; onReloadMcp: () => void;
  onPrompt: (text: string) => void; onClose: () => void; onNewSession: () => void;
}) {
  const selected = settingsPages.find((item) => item.id === page)!;
  return <>
    <nav className="settings-nav" aria-label="设置分类">
      <h2 id="desktop-settings-title">设置</h2>
      {settingsPages.map((item, index) => <button key={item.id} type="button" aria-pressed={page === item.id}
        disabled={busy} onClick={() => onPage(item.id)}><span aria-hidden="true">{["◐", "✳", "◇", "⊞", "☷", "▯"][index]}</span>{item.label}</button>)}
      <p className="settings-directory">当前目录<span title={project}>{project}</span></p>
    </nav>
    <div className="settings-main">
      <header className="settings-heading"><div><h3>{selected.label}</h3><p>{selected.description}</p></div>
        <button className="icon-button" aria-label="关闭设置" disabled={busy || themeSaving} onClick={onClose}>×</button></header>
      <div className="settings-content">
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {page === "general" ? <>
          <SettingsSection title="外观" scope="整个客户端">
            <label className="settings-row"><span>颜色主题</span><select aria-label="颜色主题" value={theme} onChange={(event) => onTheme(event.target.value as DesktopTheme)}>
              <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
            </select></label>
            {themeSaveFailed ? <p role="alert" className="field-error">外观已应用，但保存失败。<button className="text-button" onClick={() => onTheme(theme)}>重试</button></p> : null}
          </SettingsSection>
          <SettingsSection title="对话" scope="整个客户端">
            <label className="settings-row"><span>默认展开工作过程<small>查看 Chili 做了哪些步骤。</small></span><input type="checkbox" checked={preferences.expandWork} onChange={(event) => onPreferences({ ...preferences, expandWork: event.target.checked })} /></label>
            {preferenceSaveFailed ? <p role="alert" className="field-error">此次偏好未能保存，重启后将恢复上次保存的设置。</p> : null}
          </SettingsSection>
          <p className="settings-note">Chili 需要保持打开才能继续处理。重新打开后，可以接着已有会话。</p>
          <p className="settings-saved" role="status">{themeSaving ? "正在保存…" : "偏好自动保存在这台电脑上"}</p>
        </> : null}
        {page === "models" || page === "permissions" ? <>
          {config ? <SessionPreferencesForm key={`${config.model.sessionId}:${page}`} section={page} config={config} models={models} disabled={disabled} onSave={onSave} />
            : <div className="settings-empty"><p>{session ? "正在读取会话设置…" : "新建或选择一个会话后，就可以调整它的模型与协作方式。"}</p>
              {!session ? <button className="secondary" disabled={disabled} onClick={onNewSession}>新建会话</button> : null}</div>}
          {page === "models" ? <SettingsSection title="模型连接" scope="当前目录的可用配置">
            <div className="provider-list">{[...new Set(models.map((model) => model.provider))].map((provider) => {
              const catalog = models.filter((model) => model.provider === provider);
              const available = catalog.filter((model) => model.available !== false).length;
              return <div className="settings-row" key={provider}><span>{catalog[0]?.providerDisplayName ?? provider}<small>{available ? `${available} 个可用模型` : "尚未配置凭据"}</small></span><span className={`connection-label ${available ? "available" : ""}`}>{available ? "可使用" : "待配置"}</span></div>;
            })}</div>
            <p className="settings-note">这里读取 Chili 已有的模型配置。账号登录与密钥管理仍通过本机 Chili 配置完成。</p>
          </SettingsSection> : null}
        </> : null}
        {page === "tools" ? <>
          <SettingsSection title="工具连接 · MCP" scope="当前会话">
            <div className="settings-row"><span>连接状态<small>{config ? `${config.mcp.summary.running} / ${config.mcp.summary.total} 个连接正在运行` : "选择会话后查看连接状态"}</small></span><button className="secondary" disabled={disabled || !config} onClick={onReloadMcp}>重新读取</button></div>
            {config?.mcp.servers.map((server) => <div className="settings-row" key={server.name}><span>{server.name}<small>{server.error}</small></span><span className="connection-label">{server.status}</span></div>)}
            {config?.mcp.servers.length === 0 ? <p className="settings-note">当前没有配置工具连接。</p> : null}
            <p className="settings-note">连接来自已有的个人和目录配置。修改后重新读取即可生效。</p>
          </SettingsSection>
          <SettingsSection title="技能" scope="个人与当前目录">
            <p className="settings-note">Chili 会按当前目录发现可用技能。可以在会话中查看技能，并说明你希望使用的方法。</p>
            <button className="secondary" disabled={disabled} onClick={() => onPrompt("列出当前目录中可用的技能，简要说明各自能帮我做什么。")}>在会话中查看技能</button>
          </SettingsSection>
        </> : null}
        {page === "memory" ? <>
          <SettingsSection title="目录说明" scope={project}>
            <div className="settings-row"><span>AGENTS.md<small>这个目录的说明与工作约定，供会话沿用。</small></span><button className="secondary" disabled={disabled} onClick={() => onPrompt("读取当前目录适用的 AGENTS.md，向我说明已有的工作约定。先不要修改。")}>查看说明</button></div>
            <p className="settings-note">可以让 Chili 把你的偏好整理到目录说明中。每次修改仍会遵循当前权限。</p>
            <button className="secondary" disabled={disabled} onClick={() => onPrompt("请帮我更新这个目录的 AGENTS.md，记住以下工作偏好：\n")}>添加目录偏好</button>
          </SettingsSection>
          <SettingsSection title="个人记忆" scope="所有目录">
            <p className="settings-note">当前版本没有独立的个人记忆库。目录里的约定会随项目保留；会话记录也可以随时继续。</p>
          </SettingsSection>
        </> : null}
        {page === "phone" ? <RemoteControlPanel embedded /> : null}
      </div>
    </div>
  </>;
}

function SettingsSection({ title, scope, children }: { title: string; scope: string; children: ReactNode }) {
  return <section className="settings-section"><header><h4>{title}</h4><span>{scope}</span></header>{children}</section>;
}

function SessionPreferencesForm({ section, config, models, disabled, onSave }: {
  section: "models" | "permissions"; config: DesktopSessionConfig; models: readonly RuntimeModelDescriptor[];
  disabled: boolean; onSave: (values: SessionSettingsValues, section: "models" | "permissions") => void;
}) {
  const catalog = models.length ? models : config.model.models;
  const [values, setValues] = useState<SessionSettingsValues>(() => ({
    ...createSessionModelSettingsDraft(catalog, config.model),
    permissionProfile: config.permission.profile,
    reviewInstructions: config.permission.reviewInstructions,
    reviewerModelKey: config.permission.reviewerModel ? modelKey(config.permission.reviewerModel) : "",
    delegationPolicy: config.delegation.policy,
  }));
  const currentLocalModel = config.model.modelSelection;
  const missingLocalModel = currentLocalModel && !catalog.some((model) => modelKey(model) === modelKey(currentLocalModel));
  const usingLocalModel = missingLocalModel && values.modelKey === modelKey(currentLocalModel);
  const levels = usingLocalModel ? config.model.availableReasoningLevels : availableReasoningLevels(catalog, values.modelKey);
  const tiers = availableServiceTiers(catalog, values.modelKey);
  const validation = validateSessionModelSettingsDraft(values, catalog, config.model);
  const reviewerModel = config.permission.reviewerModel;
  const missingReviewerModel = reviewerModel && !catalog.some((model) => modelKey(model) === modelKey(reviewerModel));
  const valid = section === "permissions" ? values.permissionProfile === "full-access" || values.reviewInstructions.trim().length > 0 : validation.valid;
  const levelLabels: Record<string, string> = { none: "关闭", minimal: "最少", low: "较少", medium: "标准", high: "深入", xhigh: "更深入", max: "最高" };
  return <form onSubmit={(event) => { event.preventDefault(); if (valid && !disabled) onSave(values, section); }}>
    {section === "models" ? <SettingsSection title="当前会话" scope="从下一次回复开始生效">
      <label className="settings-row"><span>模型</span><select aria-label="Task model" value={values.modelKey} disabled={disabled || !catalog.length} onChange={(event) => setValues((current) => ({ ...current, ...reconcileSessionModelSettingsModel(current, catalog, event.target.value) }))}>
        {!catalog.length && !missingLocalModel ? <option value="">当前默认模型</option> : null}
        {missingLocalModel ? <option value={modelKey(currentLocalModel)}>{currentLocalModel.model} · {currentLocalModel.provider}（本地配置）</option> : null}
        {catalog.map((model) => <option key={modelKey(model)} value={modelKey(model)} disabled={model.available === false}>{model.displayName ?? model.model} · {model.providerDisplayName ?? model.provider}</option>)}
      </select></label>
      <label className="settings-row"><span>思考深度<small>更深入的思考可能需要更多时间。</small></span><select aria-label="Task reasoning" value={values.reasoningLevel} disabled={disabled || !levels.length} onChange={(event) => setValues({ ...values, reasoningLevel: event.target.value as ReasoningSelection })}>
        <option value="" disabled={!canSelectProviderDefault(config.model.reasoningLevel)}>模型默认</option>{levels.map((level) => <option key={level} value={level}>{levelLabels[level] ?? level}</option>)}
      </select></label>
      <label className="settings-row"><span>响应速度<small>{tiers.length ? "优先服务可能产生额外费用。" : "此模型使用服务商的默认速度。"}</small></span><select aria-label="Task service tier" value={values.serviceTier} disabled={disabled || !tiers.length} onChange={(event) => setValues({ ...values, serviceTier: event.target.value as ServiceTierSelection })}>
        <option value="" disabled={!canSelectProviderDefault(config.model.serviceTier)}>服务商默认</option>{tiers.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
      </select></label>
    </SettingsSection> : <>
      <SettingsSection title="工作权限" scope="个人默认设置">
        <label className="settings-row"><span>权限方式</span><select aria-label="Task permission profile" value={values.permissionProfile} disabled={disabled} onChange={(event) => setValues({ ...values, permissionProfile: event.target.value as RuntimePermissionProfileId })}>
          {config.permission.profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={Boolean(profile.disabledReason)}>{profile.id === "full-access" ? "完全访问" : "帮我审批"}</option>)}
        </select></label>
        <p className="settings-note">{values.permissionProfile === "full-access" ? "直接执行工具，不进行自动审查。" : "每次执行工具前，由独立模型根据当前任务和审查说明决定是否执行。"}</p>
        <p className="settings-note">保存后立即用于此目录的所有会话。其他已打开的目录重新打开后应用。</p>
        {values.permissionProfile === "auto-review" ? <>
          <label className="settings-row"><span>审查模型<small>独立判断即将执行的操作。</small></span><select aria-label="审查模型" value={values.reviewerModelKey} disabled={disabled} onChange={(event) => setValues({ ...values, reviewerModelKey: event.target.value })}>
            <option value="">使用默认模型</option>
            {missingReviewerModel ? <option value={modelKey(reviewerModel)}>{reviewerModel.model} · {reviewerModel.provider}（本地配置）</option> : null}
            {catalog.map((model) => <option key={modelKey(model)} value={modelKey(model)} disabled={model.available === false}>{model.displayName ?? model.model} · {model.providerDisplayName ?? model.provider}</option>)}
          </select></label>
          <label className="settings-review-instructions"><span>审查说明</span><textarea aria-label="审查说明" value={values.reviewInstructions} maxLength={32_000} rows={10} disabled={disabled} onChange={(event) => setValues({ ...values, reviewInstructions: event.target.value })} /></label>
          <div className="settings-row"><p className="settings-note">描述你希望放行或阻止的操作。每次审查都会参考这份说明。</p><button type="button" className="secondary" disabled={disabled} onClick={() => setValues({ ...values, reviewInstructions: config.permission.defaultReviewInstructions })}>恢复默认说明</button></div>
          {!values.reviewInstructions.trim() ? <p className="field-error">请填写审查说明，或恢复默认说明。</p> : null}
        </> : null}
      </SettingsSection>
      <SettingsSection title="分工协作" scope="当前会话">
        <label className="settings-row"><span>允许其他助手参与<small>复杂需求可以由多个助手分工处理。</small></span><select aria-label="Task delegation" value={values.delegationPolicy} disabled={disabled} onChange={(event) => setValues({ ...values, delegationPolicy: event.target.value as DelegationPolicy })}>
          <option value="explicit">仅当我要求</option><option value="proactive">按需分工</option><option value="off">关闭</option>
        </select></label>
      </SettingsSection>
    </>}
    {section === "models" && !valid ? <p className="settings-note">{usingLocalModel ? "正在使用本地配置的模型。无需重新保存；也可以从列表中选择其他可用模型。" : !catalog.length ? "当前配置没有可切换的模型。已有会话会继续使用默认模型。" : "请选择可用的模型、思考深度与响应速度。"}</p> : null}
    <div className="settings-save"><button className="primary" type="submit" disabled={disabled || !valid}>{disabled ? "暂不可修改" : "保存设置"}</button></div>
  </form>;
}
