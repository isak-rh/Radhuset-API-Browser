import { App } from './app.js';
import { initLocale, t } from './i18n/index.js';
import * as consent from './lib/consent.js';
import { showWelcomeDialog } from './ui/welcome.js';

initLocale();

const root = document.getElementById('app');

async function main() {
  if (consent.getState() === null) await showWelcomeDialog();
  await new App(root).start();
}

main().catch((error) => {
  console.error(error);
  const message = document.createElement('div');
  message.className = 'fatal';
  message.textContent = t('app.startFailed', { message: error.message });
  root.replaceChildren(message);
});
