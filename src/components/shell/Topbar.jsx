import { useLocation } from 'react-router-dom'
import { Search, Moon, Sun, Menu } from 'lucide-react'
import { ALL_NAV } from './nav.js'
import { useTheme } from './ThemeProvider.jsx'
import { openCommandPalette } from './CommandPalette.jsx'
import CallCounter from '../CallCounter.jsx'
import BuildBadge from '../BuildBadge.jsx'
import Kbd from '../../ui/Kbd.jsx'

function titleFor(pathname) {
  if (pathname.startsWith('/driver/')) return 'Driver'
  const match = ALL_NAV.filter((i) => i.to !== '/').find((i) => pathname.startsWith(i.to))
  if (match) return match.label
  if (pathname === '/') return 'Dashboard'
  return 'Davis Dispatch'
}

export default function Topbar({ onMenu }) {
  const { pathname } = useLocation()
  const { theme, toggle } = useTheme()

  return (
    <header className="sticky top-0 z-30 flex h-[var(--header-h)] items-center gap-3 border-b border-border bg-background/85 px-3 backdrop-blur-md md:px-5">
      <button
        type="button"
        onClick={onMenu}
        className="focus-ring grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      <h1 className="text-[15px] font-semibold tracking-tight text-foreground">{titleFor(pathname)}</h1>

      <button
        type="button"
        onClick={openCommandPalette}
        className="focus-ring ml-auto hidden h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground sm:flex"
      >
        <Search className="h-4 w-4" />
        <span>Search…</span>
        <span className="flex items-center gap-0.5">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <button
        type="button"
        onClick={openCommandPalette}
        className="focus-ring grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground sm:hidden"
        aria-label="Search"
      >
        <Search className="h-5 w-5" />
      </button>

      <div className="hidden sm:block">
        <CallCounter />
      </div>

      <button
        type="button"
        onClick={toggle}
        className="focus-ring grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Toggle theme"
      >
        {theme === 'light' ? <Moon className="h-[18px] w-[18px]" /> : <Sun className="h-[18px] w-[18px]" />}
      </button>

      <div className="hidden md:block">
        <BuildBadge />
      </div>
    </header>
  )
}
