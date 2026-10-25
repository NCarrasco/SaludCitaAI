import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { watchForUpdates } from './update-check';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
watchForUpdates();
