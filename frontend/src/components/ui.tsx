import * as RadixDialog from '@radix-ui/react-dialog'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' }) {
  const palette =
    variant === 'primary'
      ? 'bg-accent text-bg hover:opacity-90'
      : variant === 'danger'
        ? 'bg-raised text-danger border border-border hover:border-danger'
        : 'bg-raised text-text border border-border hover:bg-border/60'
  return (
    <button
      type="button"
      className={`rounded-md px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${palette} ${className}`}
      {...props}
    />
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-border bg-raised px-3 py-1.5 text-sm text-text outline-none transition focus:border-accent ${props.className ?? ''}`}
    />
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-muted text-xs">{label}</span>
      {children}
    </label>
  )
}

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-black/60" />
        <RadixDialog.Content className="fixed top-1/2 left-1/2 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5">
          <RadixDialog.Title className="mb-4 text-base font-medium">{title}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function ErrorLine({ message }: { message: string | null }) {
  if (message === null) return null
  return <p className="text-danger text-sm">{message}</p>
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-muted py-16 text-center text-sm">{children}</p>
}
