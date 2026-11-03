/**
 * SSH workspace creation dialogs that share the kernel browse picker's visual
 * language: the same 680×500 surface, title header, folder-style rows, and
 * footer actions the native local-workspace picker uses. The directory step
 * itself renders the kernel's own browse occupant (see `directory-flow.tsx`);
 * these dialogs cover the server choice and the "add server" form the kernel
 * has no equivalent for.
 *
 * @module dsh-hardssh/client/ssh-server-picker
 */

import { type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { tt } from './text.ts'
import css from './ssh-server-picker.module.css'

/** One configured SSH host, as the workspace picker lists it. */
export interface SshHostOption {
  alias: string
  host: string
  port: number
  user: string
}

/** The add-server form's draft state. */
export interface SshAddServerForm {
  alias: string
  host: string
  port: string
  user: string
  password: string
}

function ServerIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" className={className}>
      <rect x="3.5" y="4" width="17" height="7" rx="1.6" />
      <rect x="3.5" y="13" width="17" height="7" rx="1.6" />
      <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" className={className}>
      <path d="m9 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" className={className}>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
}

export interface SshServerPickerProps {
  /** Configured hosts, in host-store order. */
  hosts: SshHostOption[]
  /** An adoption/creation is in flight. */
  busy: boolean
  /** Failure copy shown above the rows (host listing or creation failures). */
  error: string | null
  /** The operator chose one server; the directory step opens next. */
  onPick: (alias: string) => void
  /** Open the add-server form. */
  onAddServer: () => void
  /** Back to the workspace intent menu. */
  onCancel: () => void
}

/** "Select SSH server" step, rendered like the kernel's picker dialog. */
export function SshServerPickerDialog({
  hosts,
  busy,
  error,
  onPick,
  onAddServer,
  onCancel,
}: SshServerPickerProps): ReactElement {
  return createPortal(
    <div
      className={css.overlay}
      data-ssh-server-picker=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label={tt('flow.sshServerTitle')}>
        <div className={css.header}>
          <h2 className={css.title}>{tt('flow.sshServerTitle')}</h2>
        </div>
        <div className={css.content}>
          {error !== null && <div className={css.error} role="alert">{error}</div>}
          <div className={css.column} role="list">
            {hosts.length === 0 && <div className={css.empty}>{tt('flow.sshNoHosts')}</div>}
            {hosts.map((host) => (
              <span key={host.alias} role="listitem" className={css.rowSeat}>
                <button
                  type="button"
                  className={css.row}
                  data-ssh-server-row={host.alias}
                  disabled={busy}
                  onClick={() => onPick(host.alias)}
                >
                  <ServerIcon className={css.rowIcon} />
                  <span className={css.rowName}>{host.alias}</span>
                  <span className={css.rowMeta}>{host.user}@{host.host}:{host.port}</span>
                  <ChevronIcon className={css.rowChevron} />
                </button>
              </span>
            ))}
          </div>
        </div>
        <div className={css.footer}>
          <button type="button" className={css.footerButton} data-ssh-add-server="" disabled={busy} onClick={onAddServer}>
            <PlusIcon />
            {tt('host.add')}
          </button>
          <span className={css.footerGap} />
          <button type="button" className={css.footerButton} disabled={busy} onClick={onCancel}>
            {tt('create.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export interface SshAddServerDialogProps {
  form: SshAddServerForm
  busy: boolean
  error: string | null
  onChange: (field: keyof SshAddServerForm, value: string) => void
  onSave: () => void
  onCancel: () => void
}

/** "Add SSH server" form, rendered like the kernel's create-folder dialog. */
export function SshAddServerDialog({
  form,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
}: SshAddServerDialogProps): ReactElement {
  const field = (key: keyof SshAddServerForm, label: string, options: { placeholder?: string; password?: boolean; numeric?: boolean } = {}): ReactElement => (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <input
        className={css.fieldInput}
        data-ssh-host-field={key}
        value={form[key]}
        placeholder={options.placeholder}
        type={options.password === true ? 'password' : 'text'}
        inputMode={options.numeric === true ? 'numeric' : undefined}
        spellCheck={false}
        disabled={busy}
        onChange={(event) => onChange(key, event.target.value)}
      />
    </label>
  )
  return createPortal(
    <div
      className={`${css.overlay} ${css.overlayTop}`}
      data-ssh-add-server-dialog=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div className={css.addDialog} role="dialog" aria-modal="true" aria-label={tt('host.add')}>
        <h3 className={css.addTitle}>{tt('host.add')}</h3>
        <p className={css.addHint}>{tt('dialog.passwordHint')}</p>
        <div className={css.fields}>
          {field('alias', tt('dialog.alias'), { placeholder: 'my-server' })}
          {field('host', tt('dialog.host'), { placeholder: '1.2.3.4' })}
          {field('port', tt('dialog.port'), { numeric: true })}
          {field('user', tt('dialog.user'), { placeholder: 'root' })}
          {field('password', tt('dialog.password'), { password: true })}
        </div>
        {error !== null && <div className={css.error} role="alert">{error}</div>}
        <div className={css.addActions}>
          <button type="button" className={css.footerButton} disabled={busy} onClick={onCancel}>
            {tt('create.cancel')}
          </button>
          <button type="button" className={css.footerPrimary} data-ssh-host-save="" disabled={busy} onClick={onSave}>
            {busy ? tt('create.connecting') : tt('host.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
