import { cpSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const { version, buildNumber } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const target = env.VITE_HA_DEV_PROXY_ORIGIN?.replace(/\/+$/, '');
  return {
    base: './',
    define: {
      __LEAPMORE_VERSION__: JSON.stringify(version),
      __LEAPMORE_BUILD__: JSON.stringify(String(buildNumber)),
      __LEAPMORE_LOCAL_ASSETS__: JSON.stringify(env.LEAPMORE_LOCAL_CAR_ASSETS === '1'),
      __LEAPMORE_LOCAL_3D__: JSON.stringify(env.LEAPMORE_LOCAL_3D_DEMO === '1'),
    },
    plugins: [react(), {
      name: 'leapmore-public-assets',
      apply: 'build',
      closeBundle() {
        const files = ['manifest.webmanifest', 'checkin-page.js', 'viewer/isolated.js', 'viewer/view.js', 'viewer/view.html',
          ...['leaplink-icon.png', 'leaplink-icon-simple.png', 'leaplink-lockup.png', 'wechat-reward-qr.png'].map(name => 'assets/' + name)];
        if (env.LEAPMORE_LOCAL_CAR_ASSETS === '1') files.push(...['b10', 'c10', 'hero-day', 'hero-night'].map(name => 'assets/' + name + '.png'));
        if (env.LEAPMORE_LOCAL_3D_DEMO === '1') files.push('car3d-demo');
        for (const file of files) {
          const from = resolve(import.meta.dirname, 'public', file);
          if (!existsSync(from)) continue;
          cpSync(from, resolve(import.meta.dirname, 'dist', file), { recursive: true, dereference: true,
            filter: source => !/[/\\](\.DS_Store|skybox_night_starry\.jpg)$/.test(source),
          });
        }
      },
    }],
    build: { copyPublicDir: false, rollupOptions: { input: {
      index: resolve(import.meta.dirname, 'index.html'),
      callback: resolve(import.meta.dirname, 'ha-callback.html'),
    } } },
    server: target ? { proxy: {
      '^/__ha/(api/states(?:\\?|$)|api/websocket$|api/history/period/|auth/token(?:\\?|$))': {
        target, changeOrigin: true, ws: true, rewrite: path => path.replace(/^\/__ha/, ''),
        configure(proxy) {
          proxy.on('proxyReq', request => {
            request.removeHeader('cookie');
            request.removeHeader('origin');
            request.removeHeader('referer');
          });
        },
      },
    } } : undefined,
  };
});
