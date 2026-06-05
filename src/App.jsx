import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Workbench from './pages/Workbench.jsx'
import Loads from './pages/Loads.jsx'
import Stops from './pages/Stops.jsx'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="workbench" element={<Workbench />} />
        <Route path="loads" element={<Loads />} />
        <Route path="stops" element={<Stops />} />
        {/* Unknown routes fall back to the Dashboard. */}
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  )
}
