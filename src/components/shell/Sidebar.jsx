import { NavLink } from 'react-router-dom'
import { Truck } from 'lucide-react'
import { NAV_GROUPS } from './nav.js'
import { cn } from '../../lib/cn.js'

function Item({ item, onNavigate }) {
  if (item.soon) {
    return (
      <div
        className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground/50"
        title="Coming soon"
      >
        <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.9} />
        <span className="truncate">{item.label}</span>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground/70">soon</span>
      </div>
    )
  }
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
          isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon className={cn('h-[18px] w-[18px] shrink-0', isActive && 'text-primary')} strokeWidth={1.9} />
          <span className="truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  )
}

export default function Sidebar({ className, onNavigate }) {
  return (
    <aside className={cn('w-[var(--sidebar-w)] shrink-0 flex-col border-r border-border bg-background-subtle', className)}>
      <div className="flex h-[var(--header-h)] items-center gap-2.5 px-4">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-soft">
          <Truck className="h-4 w-4" strokeWidth={2.2} />
        </span>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight text-foreground">Davis Dispatch</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">TMS</div>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <Item key={item.to} item={item} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">UAT · NuVizz live</div>
    </aside>
  )
}
