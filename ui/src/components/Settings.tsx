// M8f: «Настройки» (⌘,). Раздел «Новая сессия» — умолчания по провайдерам и «Подставлять последний выбор»;
// «Внешний вид» пока пустой (темы и цвета — после редизайна, docs/15). Логика черновика — model/sessionSettings.ts.

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { APPROVAL_LABEL, PRESETS } from '../model/newAgent.js'
import { DEFAULT_APPROVALS, draftError, effortOptions, setDefault, setDefaultProvider, settingsDraft } from '../model/sessionSettings.js'
import type { NewSessionSettings, Provider } from '../../../src/sessions/settings.js'
import type { ProviderCatalog } from '../model/types.js'
import { CMD, Kbd } from './common.js'
import { Dialog } from './Panels.js'

const PROVIDERS: readonly Provider[] = ['claude', 'codex']

function ProviderDefaultsBox({ provider, draft, catalog, onChange }: {
  provider: Provider; draft: NewSessionSettings; catalog: ProviderCatalog | null; onChange(d: NewSessionSettings): void
}): ReactElement {
  const d = draft.defaults[provider]
  const models: Array<{ id: string; label: string }> = provider === 'claude'
    ? PRESETS.claude.models.map((id) => ({ id, label: id }))
    : (catalog?.codex.models ?? []).map((m) => ({ id: m.id, label: m.label }))
  if (d.model && !models.some((m) => m.id === d.model)) models.unshift({ id: d.model, label: d.model })
  const efforts = effortOptions(provider, catalog, d.model)
  const effortList = d.effort && !efforts.includes(d.effort) ? [d.effort, ...efforts] : efforts
  const id = (k: string): string => `set-${provider}-${k}`
  return (
    <fieldset data-testid={`settings-${provider}`}>
      <legend>{provider}</legend>
      <label className="field" htmlFor={id('model')}>
        <span className="lbl">модель</span>
        <select id={id('model')} value={d.model ?? ''} data-testid={`settings-${provider}-model`}
          onChange={(e) => onChange(setDefault(draft, provider, 'model', e.target.value))}>
          <option value="">{provider === 'codex' ? 'по умолчанию Codex' : `как в форме (${PRESETS.claude.defaultModel})`}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {provider === 'codex' && !catalog?.codex.models.length && <span className="note">список моделей Codex не загружен — «Проверить» в «+ Сессия»</span>}
      </label>
      <label className="field" htmlFor={id('effort')}>
        <span className="lbl">усилие</span>
        <select id={id('effort')} value={d.effort ?? ''} data-testid={`settings-${provider}-effort`}
          onChange={(e) => onChange(setDefault(draft, provider, 'effort', e.target.value))}>
          <option value="">как в форме</option>
          {effortList.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </label>
      <label className="field" htmlFor={id('approval')}>
        <span className="lbl">подтверждения</span>
        <select id={id('approval')} value={d.approval ?? ''} data-testid={`settings-${provider}-approval`}
          onChange={(e) => onChange(setDefault(draft, provider, 'approval', e.target.value as typeof d.approval | ''))}>
          <option value="">как в форме ({APPROVAL_LABEL.ask.toLowerCase()})</option>
          {DEFAULT_APPROVALS.map((a) => <option key={a} value={a}>{APPROVAL_LABEL[a]}</option>)}
        </select>
        <span className="note">«Полный доступ» по умолчанию не ставится — только явно при заведении.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={d.mode === 'warm'} data-testid={`settings-${provider}-warm`}
          onChange={(e) => onChange(setDefault(draft, provider, 'mode', e.target.checked ? 'warm' : undefined))} />
        <span>Тёплый процесс между репликами</span>
        {provider === 'codex' && <span className="note">у Codex процесс app-server и так общий — флаг ни на что не влияет</span>}
      </label>
      <label className="check">
        <input type="checkbox" checked={d.browser === true} data-testid={`settings-${provider}-browser`}
          onChange={(e) => onChange(setDefault(draft, provider, 'browser', e.target.checked ? true : undefined))} />
        <span>Браузер для агента</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={d.worktree === true} data-testid={`settings-${provider}-worktree`}
          onChange={(e) => onChange(setDefault(draft, provider, 'worktree', e.target.checked ? true : undefined))} />
        <span>Предлагать ветку worktree (pult/&lt;имя&gt;)</span>
      </label>
    </fieldset>
  )
}

export function SettingsDialog({ settings, catalog, onSave, onClose }: {
  settings: NewSessionSettings | null
  catalog: ProviderCatalog | null
  /** `null` — записано; строка — отказ демона. */
  onSave(next: NewSessionSettings): Promise<string | null>
  onClose(): void
}): ReactElement {
  const [draft, setDraft] = useState<NewSessionSettings>(() => settingsDraft(settings))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const first = useRef<HTMLSelectElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const invalid = draftError(draft)
  const save = async (): Promise<void> => {
    if (busy || invalid) return
    setBusy(true)
    setErr(null)
    const e = await onSave(draft)
    setBusy(false)
    if (e) setErr(e)
  }
  return (
    <Dialog title="Настройки" size="wide" onClose={onClose} testId="settings-dialog"
      footer={<>
        {(err ?? invalid) && <span className="err" role="alert" data-testid="settings-error">{err ?? invalid}</span>}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>Отмена <Kbd>Esc</Kbd></button>
        <button type="button" className="btn btn-primary" disabled={busy || !!invalid} onClick={() => void save()} data-testid="settings-save">
          {busy ? 'Сохраняю…' : 'Сохранить'} <Kbd>{`${CMD}↵`}</Kbd>
        </button>
      </>}>
      <div className="form-stack" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void save() } }}>
        <section className="settings-sec" aria-labelledby="settings-new-h" data-testid="settings-new-session">
          <h3 id="settings-new-h">Новая сессия</h3>
          <label className="field" htmlFor="set-provider">
            <span className="lbl">провайдер по умолчанию</span>
            <select id="set-provider" ref={first} value={draft.defaults.provider ?? ''} data-testid="settings-provider"
              onChange={(e) => setDraft(setDefaultProvider(draft, e.target.value as Provider | ''))}>
              <option value="">как в форме (claude)</option>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.rememberLast} data-testid="settings-remember-last"
              onChange={(e) => setDraft({ ...draft, rememberLast: e.target.checked })} />
            <span>Подставлять последний выбор</span>
            <span className="note">«+ Сессия» откроется с тем, что ты выбрал в прошлый раз (кроме реплики и «Полного доступа»); иначе — с умолчаниями ниже. pult agent start всегда берёт умолчания.</span>
          </label>
          <div className="settings-prov">
            {PROVIDERS.map((p) => <ProviderDefaultsBox key={p} provider={p} draft={draft} catalog={catalog} onChange={setDraft} />)}
          </div>
        </section>
        <section className="settings-sec" aria-labelledby="settings-look-h" data-testid="settings-appearance">
          <h3 id="settings-look-h">Внешний вид</h3>
          <span className="note">Темы и цвета — после редизайна.</span>
        </section>
      </div>
    </Dialog>
  )
}
