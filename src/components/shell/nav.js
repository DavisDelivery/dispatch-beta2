import {
  LayoutDashboard,
  Truck,
  Route,
  PackagePlus,
  Map,
  Boxes,
  MapPin,
  Wrench,
  Users,
  Warehouse,
  Receipt,
  BarChart3,
} from 'lucide-react'

// Primary navigation. `soon: true` items render disabled until a data feed
// exists — honest "coming soon" instead of empty shells.
export const NAV_GROUPS = [
  {
    label: 'Operate',
    items: [
      { to: '/dispatch', label: 'Dispatch', icon: Truck },
      { to: '/routing', label: 'Routing', icon: Route },
      { to: '/build', label: 'Orders', icon: PackagePlus },
      { to: '/map', label: 'Live Map', icon: Map },
    ],
  },
  {
    label: 'Insight',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/loads', label: 'Loads', icon: Boxes },
      { to: '/stops', label: 'Stops', icon: MapPin },
      { to: '/workbench', label: 'Workbench', icon: Wrench },
    ],
  },
  {
    label: 'Coming soon',
    items: [
      { to: '/customers', label: 'Customers', icon: Users, soon: true },
      { to: '/fleet', label: 'Fleet', icon: Truck, soon: true },
      { to: '/warehouse', label: 'Warehouse', icon: Warehouse, soon: true },
      { to: '/billing', label: 'Billing', icon: Receipt, soon: true },
      { to: '/analytics', label: 'Analytics', icon: BarChart3, soon: true },
    ],
  },
]

export const ALL_NAV = NAV_GROUPS.flatMap((g) => g.items)
