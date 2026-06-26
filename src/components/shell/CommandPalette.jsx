import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import { Moon, Sun, CornerDownLeft, PackagePlus } from 'lucide-react'
import { ALL_NAV } from './nav.js'
import { useTheme } from './ThemeProvider.jsx'
import Kbd from '../../ui/Kbd.jsx'

export const openCommandPalette = () => window.dispatchEvent(new Event('dd-command-open'))

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { theme, toggle } = useTheme()

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('dd-command-open', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dd-command-open', onOpen)
    }
  }, [])

  const run = (fn) => () => {
    setOpen(false)
    fn()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade-in bg-background/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <Command
        label="Command palette"
        className="relative w-full max-w-xl animate-scale-in overflow-hidden rounded-xl border border-border bg-popover shadow-pop"
        loop
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Command.Input
            autoFocus
            placeholder="Search or jump to…"
            className="h-12 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Kbd>Esc</Kbd>
        </div>
        <Command.List className="max-h-[340px] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">No results.</Command.Empty>

          <Command.Group heading="Navigate" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground/70">
            {ALL_NAV.filter((i) => !i.soon).map((item) => (
              <Item key={item.to} icon={item.icon} onSelect={run(() => navigate(item.to))}>
                {item.label}
              </Item>
            ))}
          </Command.Group>

          <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground/70">
            <Item icon={PackagePlus} onSelect={run(() => navigate('/build'))}>
              Create order
            </Item>
            <Item icon={theme === 'light' ? Moon : Sun} onSelect={run(toggle)}>
              Switch to {theme === 'light' ? 'dark' : 'light'} mode
            </Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  )
}

function Item({ icon: Icon, children, onSelect }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground aria-selected:bg-accent aria-selected:text-foreground"
    >
      {Icon && <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} />}
      <span className="flex-1">{children}</span>
      <CornerDownLeft className="h-3.5 w-3.5 opacity-0 aria-selected:opacity-100" />
    </Command.Item>
  )
}
