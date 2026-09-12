import { App } from './app.js';
import { initLocale, t } from './i18n/index.js';

initLocale();

const root = document.getElementById('app');

new App(root).start().catch((error) => {
  console.error(error);
  const message = document.createElement('div');
  message.className = 'fatal';
  message.textContent = t('app.startFailed', { message: error.message });
  root.replaceChildren(message);
});
