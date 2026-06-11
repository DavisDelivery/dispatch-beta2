import { NavLink, Outlet } from 'react-router-dom'
import BuildBadge from './BuildBadge.jsx'
import DateNav from './DateNav.jsx'

// Primary nav — rail order mirrors NuVizz's Transport group.
// `short` labels keep the bottom bar legible at phone width.
const NAV = [
  { to: '/', label: 'Dashboard', short: 'Dashboard', icon: 'grid', end: true },
  { to: '/workbench', label: 'Route Workbench', short: 'Workbench', icon: 'wrench' },
  { to: '/loads', label: 'Loads', short: 'Loads', icon: 'box' },
  { to: '/stops', label: 'Stops', short: 'Stops', icon: 'pin' },
]

// Generic stroke icons — NOT NuVizz assets.
function Icon({ name }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }
  switch (name) {
    case 'grid':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      )
    case 'wrench':
      return (
        <svg {...common}>
          <path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.3 2.3-2-2 2.3-2.3z" />
        </svg>
      )
    case 'box':
      return (
        <svg {...common}>
          <path d="M21 8 12 3 3 8l9 5 9-5z" />
          <path d="M3 8v8l9 5 9-5V8" />
          <path d="M12 13v8" />
        </svg>
      )
    case 'pin':
      return (
        <svg {...common}>
          <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" />
          <circle cx="12" cy="10" r="2.5" />
        </svg>
      )
    default:
      return null
  }
}

export default function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__mark" aria-hidden="true">▦</span>
          <span className="topbar__title">Davis Dispatch</span>
        </div>
        <BuildBadge />
      </header>

      <DateNav />

      <div className="body">
        <nav className="rail" aria-label="Primary navigation">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rail__link ${isActive ? 'is-active' : ''}`
              }
            >
              <Icon name={item.icon} />
              <span className="rail__label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <main className="content">
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Primary navigation">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `bottom-nav__link ${isActive ? 'is-active' : ''}`
            }
          >
            <Icon name={item.icon} />
            <span className="bottom-nav__label">{item.short}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
