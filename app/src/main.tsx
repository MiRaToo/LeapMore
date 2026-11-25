import 'core-js/es/object/has-own';
import 'core-js/es/array/at';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ModelProvider } from './features/context';
import { androidWidgetControl } from './platform/widgets';
import './theme.css';
import './app.css';

const queries = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnReconnect: 'always', retry: 1 } } });
const widgetControl = androidWidgetControl();
if (widgetControl) document.documentElement.classList.add('widget-control-window');
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queries}><HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ModelProvider widgetControl={!!widgetControl}><App widgetControl={widgetControl} /></ModelProvider></HashRouter></QueryClientProvider>,
);
