import { forwardRef } from 'react'
import { cn } from '../lib/cn.js'

const VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-soft',
  secondary: 'bg-card text-foreground border border-border hover:bg-card-hover hover:border-border-strong',
  ghost: 'text-muted-foreground hover:text-foreground hover:bg-accent',
  outline: 'border border-border text-foreground hover:bg-accent hover:border-border-strong',
  danger: 'bg-destructive text-white hover:bg-destructive/90 shadow-soft',
  subtle: 'bg-muted text-foreground hover:bg-muted/70',
}

const SIZES = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-xl',
  icon: 'h-9 w-9 rounded-lg',
}

const Button = forwardRef(function Button(
  { className, variant = 'secondary', size = 'md', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'focus-ring inline-flex select-none items-center justify-center font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
})

export default Button
