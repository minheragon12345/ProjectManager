import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

import Login from './pages/Login';
import Register from './pages/Register';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import ProjectOptimize from './pages/ProjectOptimize';
import MyTime from './pages/MyTime';
import Reports from './pages/Reports';
import AdminBilling from './pages/AdminBilling';
import { me } from './services/authService';
import { LanguageProvider } from './i18n';
import ErrorBoundary from './components/ErrorBoundary';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('token'));
  const [user, setUser] = useState(() => {
    try {
      const s = localStorage.getItem('user');
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const handler = () => {
      setIsAuthenticated(!!localStorage.getItem('token'));
      try {
        const s = localStorage.getItem('user');
        setUser(s ? JSON.parse(s) : null);
      } catch {
        setUser(null);
      }
    };
    window.addEventListener('authChange', handler);
    return () => window.removeEventListener('authChange', handler);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    if (user) return;

    (async () => {
      try {
        const data = await me();
        if (data?.user) {
          localStorage.setItem('user', JSON.stringify(data.user));
          setUser(data.user);
          window.dispatchEvent(new Event('authChange'));
        }
      } catch {
      }
    })();
  }, [user]);

  // Wrapper: every page goes through this boundary so a crash inside a
  // route renders the diagnostic card instead of blanking the React tree.
  const guard = (node) => <ErrorBoundary label="Page failed to render">{node}</ErrorBoundary>;

  return (
    <LanguageProvider>
    <Router>
      <ToastContainer position="top-right" autoClose={3000} />
      <Routes>
        <Route path="/login" element={guard(<Login />)} />
        <Route path="/register" element={guard(<Register />)} />
        <Route
          path="/"
          element={isAuthenticated ? <Navigate to="/projects" replace /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/projects"
          element={isAuthenticated ? guard(<Projects />) : <Navigate to="/login" />}
        />
        <Route
          path="/projects/:id"
          element={isAuthenticated ? guard(<ProjectDetail />) : <Navigate to="/login" />}
        />
        <Route
          path="/projects/:id/optimize"
          element={isAuthenticated ? guard(<ProjectOptimize />) : <Navigate to="/login" />}
        />
        <Route
          path="/my-time"
          element={isAuthenticated ? guard(<MyTime />) : <Navigate to="/login" />}
        />
        <Route
          path="/reports"
          element={isAuthenticated ? guard(<Reports />) : <Navigate to="/login" />}
        />
        <Route
          path="/admin/billing"
          element={isAuthenticated ? guard(<AdminBilling />) : <Navigate to="/login" />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
    </LanguageProvider>
  );
}

export default App;
