import { cn } from '../lib/cn.js'

export function Card({ className, ...props }) {
  return <div className={cn('rounded-xl border border-border bg-card shadow-soft', className)} {...props} />
}

export function CardHeader({ className, ...props }) {
  return <div className={cn('flex items-start justify-between gap-3 px-4 pt-4', className)} {...props} />
}

export function CardTitle({ className, ...props }) {
  return <h3 className={cn('text-sm font-semibold tracking-tight text-foreground', className)} {...props} />
}

export function CardBody({ className, ...props }) {
  return <div className={cn('p-4', className)} {...props} />
}
