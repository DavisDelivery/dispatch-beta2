import { Routes, Route } from 'react-router-dom'
import AppShell from './components/shell/AppShell.jsx'
import Dispatch from './pages/Dispatch.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Workbench from './pages/Workbench.jsx'
import Loads from './pages/Loads.jsx'
import Stops from './pages/Stops.jsx'
import MapPage from './pages/Map.jsx'
import RoutingPage from './pages/Routing.jsx'
import Driver from './pages/Driver.jsx'
import Builder from './pages/Builder.jsx'

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="dispatch" element={<Dispatch />} />
        <Route path="workbench" element={<Workbench />} />
        <Route path="loads" element={<Loads />} />
        <Route path="stops" element={<Stops />} />
        <Route path="map" element={<MapPage />} />
        <Route path="routing" element={<RoutingPage />} />
        <Route path="build" element={<Builder />} />
        <Route path="driver/:userName" element={<Driver />} />
        {/* Unknown routes fall back to the Dashboard. */}
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  )
}
