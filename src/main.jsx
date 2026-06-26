import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@fontsource-variable/inter'
import App from './App.jsx'
import { seedCreatedOrders } from './lib/createdOrders.js'
import './index.css'
import './styles/theme.css'

// Seed the starter orders (real UAT stops) once per browser so the board has
// something to plan on first load.
seedCreatedOrders()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
