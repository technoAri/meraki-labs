import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard.js';
import DLQ from './pages/DLQ.js';
import './index.css';

const API_KEY = import.meta.env.VITE_API_KEY ?? 'test-api-key-1234';
export { API_KEY };

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/dlq" element={<DLQ />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
