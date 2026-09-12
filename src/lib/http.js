import { t } from '../i18n/index.js';

/** A non-2xx response, with whatever explanation the server gave. */
export class HttpError extends Error {
  constructor(status, detail, url) {
    super(`${status} ${statusText(status)}${detail ? ` — ${detail}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
    this.url = url;
  }
}

/** The request never produced a response: offline, DNS, TLS, or blocked by CORS. */
export class NetworkError extends Error {
  constructor(url) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep the raw value */
    }
    super(t('http.couldNotReach', { host }));
    this.name = 'NetworkError';
    this.url = url;
  }
}

function statusText(status) {
  const text = t(`http.status.${status}`);
  return text === `http.status.${status}` ? '' : text;
}

/** A short, human-readable reason from an error response body, if it has one. */
export async function responseDetail(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return '';
  }
  try {
    const data = JSON.parse(text);
    const found = [data.description, data.detail, data.message, data.error_description, data.title, data.error]
      .find((v) => typeof v === 'string' && v.trim());
    if (found) return found.trim().slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** fetch() that turns a failed request into NetworkError and keeps AbortError as is. */
export async function request(url, init = {}) {
  try {
    return await fetch(url, { credentials: 'omit', ...init });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new NetworkError(url);
  }
}

export async function ensureOk(response) {
  if (!response.ok) throw new HttpError(response.status, await responseDetail(response), response.url);
  return response;
}

export function isAbort(error) {
  return error?.name === 'AbortError';
}
