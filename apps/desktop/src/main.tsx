import React from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import App from './App';
import './styles.css';
import './workspace-layout.css';

if (isTauri() && navigator.platform.startsWith('Mac')) document.documentElement.dataset.nativePlatform = 'macos';

const container = document.getElementById('root');
if (!container) throw new Error('无法找到应用容器');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
