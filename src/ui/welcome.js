// First-run welcome screen: explains the app, its license and how credentials
// are handled, and asks for consent to store data on this device (EU
// ePrivacy/GDPR). Blocking — it can only be closed via the two buttons.

import * as consent from '../lib/consent.js';
import { button, h } from '../lib/dom.js';
import { t } from '../i18n/index.js';
import { openDialog } from './dialog.js';

const GITHUB_URL = 'https://github.com/isak-rh/Radhuset-API-Browser';
const RADHUSET_URL = 'https://radhuset.se';

/** Opens a two-button (decline/allow) consent dialog. Resolves true if consent was granted. */
function openConsentDialog({ title, className = null, body }) {
  return new Promise((resolve) => {
    let granted = false;
    const decide = (value) => {
      granted = value;
      if (granted) consent.setGranted();
      else consent.setDeclined();
      dialog.close();
    };
    const dialog = openDialog({
      title,
      size: 'sm',
      dismissible: false,
      className,
      body,
      footer: [
        button(t('welcome.decline'), { onClick: () => decide(false) }),
        button(t('welcome.allow'), { variant: 'primary', autofocus: true, onClick: () => decide(true) }),
      ],
      onClose: () => resolve(granted),
    });
  });
}

/** Shown once, on first visit. Resolves true if consent was granted. */
export function showWelcomeDialog() {
  return openConsentDialog({
    title: t('welcome.title'),
    className: 'welcome-dialog',
    body: h(
      'div',
      { class: 'welcome' },
      h('a', { href: RADHUSET_URL, target: '_blank', rel: 'noopener' }, h('img', { src: 'assets/radhuset-logo.svg', alt: t('welcome.logoAlt'), class: 'welcome-logo' })),
      h('p', { text: t('welcome.purpose') }),
      h('p', { text: t('welcome.license') }),
      h('p', null, h('a', { href: GITHUB_URL, target: '_blank', rel: 'noopener', text: t('welcome.sourceCode') })),
      h('p', { text: t('welcome.credentials') }),
      h('p', { text: t('welcome.consent') }),
      h('p', { class: 'muted small', text: t('welcome.declineNote') }),
    ),
  });
}

/** Shown when a user who declined tries to persist an auth profile. Resolves true if consent was granted. */
export function showConsentReprompt() {
  return openConsentDialog({
    title: t('welcome.repromptTitle'),
    body: h('div', { class: 'message' }, h('p', { text: t('welcome.repromptBody') })),
  });
}
