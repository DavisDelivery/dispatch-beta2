import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { ThemeProvider } from './ThemeProvider.jsx'
import Sidebar from './Sidebar.jsx'
import Topbar from './Topbar.jsx'
import CommandPalette from './CommandPalette.jsx'
import DateNav from '../DateNav.jsx'

// Legacy date-driven pages still use the shared ?date stepper.
const DATE_ROUTES = ['/', '/loads', '/stops', '/map', '/workbench', '/routing']
const showsDate = (p) => DATE_ROUTES.some((r) => (r === '/' ? p === '/' : p.startsWith(r)))

export default function AppShell() {
  const [drawer, setDrawer] = useState(false)
  const { pathname } = useLocation()

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawer(false), [pathname])

  return (
    <ThemeProvider>
      <div className="tms flex h-[100dvh] overflow-hidden bg-background text-foreground">
        <Sidebar className="hidden md:flex" />

        {/* Mobile drawer */}
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 animate-fade-in bg-background/70 backdrop-blur-sm" onClick={() => setDrawer(false)} />
            <div className="absolute inset-y-0 left-0 animate-slide-up">
              <Sidebar className="flex h-full" onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenu={() => setDrawer(true)} />
          <main className="flex-1 overflow-y-auto">
            {showsDate(pathname) && <DateNav />}
            <Outlet />
          </main>
        </div>

        <CommandPalette />
      </div>
    </ThemeProvider>
  )
}
