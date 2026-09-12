// The download flow: confirm what will be fetched and where it goes, then show
// progress per file.
//
// Where it goes depends on what the browser can do, tested at runtime:
//   • File System Access (Chromium): straight into a folder the user picks,
//     streamed to disk, resumable — files already there are skipped.
//   • Otherwise: through the browser's own downloads, either as one ZIP or as
//     separate files. Both hold each file in memory until it completes, which
//     the user is told before starting.

import { StacClient } from '../stac/client.js';
import { DownloadRun, planDownload } from '../downloads/runner.js';
import { ensureWritable, folderAccessSupport, pickFolder, recallFolder, rememberFolder } from '../downloads/folder.js';
import { BrowserFilesTarget, FolderTarget, ZipTarget } from '../downloads/targets.js';
import { button, clear, h, icon } from '../lib/dom.js';
import { formatBytes, formatDuration } from '../lib/format.js';
import { t, tn } from '../i18n/index.js';
import { ensureCredentials } from './credentials.js';
import { confirmDialog, openDialog } from './dialog.js';
import { toast } from './toast.js';

// fflate writes no ZIP64, and the archive is assembled in memory: stay well clear
// of 4 GB.
const ZIP_MAX_BYTES = 2e9;
const LARGE_DOWNLOAD_BYTES = 1e9;

const STATUS_ICONS = { queued: null, active: 'download', done: 'check', skipped: 'check', failed: 'alert', cancelled: 'x' };

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const slug = (text) => text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'download';

function stat(value, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value', text: value }), h('div', { class: 'stat-label', text: label }));
}

function choiceCard(input, title, description) {
  return h('label', { class: 'choice-card' }, input, h('span', null, h('strong', { text: title }), description ? h('span', { class: 'muted small', text: description }) : null));
}

/** Download *entries* ([{ item, asset }]) from the API that produced the results. */
export async function startDownload(app, { entries }) {
  if (app.activeDownload) {
    toast(t('download.alreadyRunningToast'), { kind: 'warning' });
    return;
  }
  const api = app.results.api || app.api;
  const plan = planDownload(entries);
  if (!plan.jobs.length) {
    toast(t('download.noFilesToast'), { kind: 'info' });
    return;
  }
  if (!(await ensureCredentials(app, api, 'download'))) return;

  const support = folderAccessSupport();
  let folder = support.supported ? await recallFolder() : null;
  const itemCount = new Set(plan.jobs.map((j) => j.item.uid)).size;
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });
  const showError = (message) => {
    error.textContent = message;
    error.hidden = !message;
  };

  // ── Confirmation ──────────────────────────────────────────────────────

  let sizeText = plan.knownBytes ? formatBytes(plan.knownBytes) : t('download.unknown');
  if (plan.knownBytes && plan.unknownSizes) sizeText += '+';
  const summary = h(
    'div',
    { class: 'dl-summary' },
    stat(tn('download.filesCount', plan.jobs.length), tn('download.fromItemsCount', itemCount)),
    stat(sizeText, plan.unknownSizes && plan.knownBytes ? tn('download.unknownSizeFiles', plan.unknownSizes) : t('download.inTotal')),
  );
  const duplicateNote = plan.duplicates
    ? h('p', { class: 'muted small', text: tn('download.duplicatesSkipped', plan.duplicates) })
    : null;

  let destination;
  let skipExisting = null;
  let zipChoice = null;
  if (support.supported) {
    const folderName = h('strong');
    const choose = button(t('download.chooseFolder'), { size: 'sm' });
    const renderFolder = () => {
      folderName.textContent = folder ? folder.name : t('download.folderNotChosen');
      choose.querySelector('span').textContent = folder ? t('download.changeFolder') : t('download.chooseFolder');
    };
    choose.addEventListener('click', async () => {
      showError('');
      try {
        folder = await pickFolder(folder || undefined);
        renderFolder();
      } catch (err) {
        if (err?.name !== 'AbortError') showError(t('download.folderOpenFailed', { message: err.message }));
      }
    });
    renderFolder();
    skipExisting = h('input', { type: 'checkbox', checked: true });
    destination = h(
      'div',
      { class: 'dl-destination' },
      h('div', { class: 'folder-row' }, icon('folder', { size: 22 }), h('div', { class: 'grow' }, h('div', { class: 'muted small', text: t('download.saveIntoFolder') }), folderName), choose),
      h('label', { class: 'check' }, skipExisting, h('span', { text: t('download.skipExisting') })),
    );
  } else {
    const zipAllowed = plan.jobs.length > 1 && plan.knownBytes <= ZIP_MAX_BYTES;
    zipChoice = h('input', { type: 'radio', name: 'dl-mode', value: 'zip', checked: zipAllowed, disabled: !zipAllowed || null });
    const separate = h('input', { type: 'radio', name: 'dl-mode', value: 'files', checked: !zipAllowed });
    destination = h(
      'div',
      { class: 'dl-destination' },
      h(
        'div',
        { class: 'notice notice-warning' },
        icon('info', { size: 18 }),
        h(
          'div',
          null,
          h('strong', { text: t('download.browserDownloadWarningTitle') }),
          h('p', { text: t('download.browserDownloadWarningBody', { reason: support.reason }) }),
        ),
      ),
      plan.jobs.length > 1
        ? h(
            'fieldset',
            { class: 'choice-cards' },
            h('legend', { text: t('download.saveAs') }),
            choiceCard(zipChoice, t('download.oneZipFile'), zipAllowed ? t('download.zipEverything') : t('download.zipNotAvailableAbove', { size: formatBytes(ZIP_MAX_BYTES) })),
            choiceCard(separate, t('download.separateFiles'), t('download.separateFilesDesc')),
          )
        : null,
      plan.knownBytes > LARGE_DOWNLOAD_BYTES
        ? h('p', { class: 'notice small', text: t('download.largeDownloadNotice', { size: formatBytes(plan.knownBytes) }) })
        : null,
    );
  }

  const startButton = button(t('download.downloadButton'), { icon: 'download', variant: 'primary' });
  const dialog = openDialog({
    title: plan.jobs.length === 1 ? t('download.downloadFileTitle') : t('download.downloadFilesTitle'),
    size: 'md',
    body: h('div', { class: 'form' }, summary, duplicateNote, destination, error),
    footer: [button(t('common.cancel'), { onClick: () => dialog.close() }), startButton],
    canClose: () => (run ? requestCancel() : true),
  });

  let run = null;

  startButton.addEventListener('click', async () => {
    showError('');
    let target;
    if (support.supported) {
      try {
        if (!folder) folder = await pickFolder();
      } catch (err) {
        if (err?.name !== 'AbortError') showError(t('download.folderOpenFailed', { message: err.message }));
        return;
      }
      let writable = false;
      try {
        writable = await ensureWritable(folder);
      } catch (err) {
        showError(err.message);
        return;
      }
      if (!writable) {
        showError(t('download.permissionNotGranted'));
        return;
      }
      rememberFolder(folder);
      target = new FolderTarget(folder);
    } else {
      target = zipChoice?.checked ? new ZipTarget(`${slug(api.name)}_${timestamp()}.zip`) : new BrowserFilesTarget();
    }
    runJobs(plan.jobs, target, Boolean(skipExisting?.checked));
  });

  // ── Progress ──────────────────────────────────────────────────────────

  async function requestCancel() {
    if (!run || run.cancelled) return false;
    const confirmed = await confirmDialog({
      title: t('download.cancelTitle'),
      message: t('download.cancelMessage'),
      confirmLabel: t('download.cancelDownload'),
      cancelLabel: t('download.keepDownloading'),
      danger: true,
    });
    if (confirmed) run.cancel();
    return false;
  }

  function runJobs(jobs, target, skip) {
    const client = new StacClient(api, app.auth);
    run = new DownloadRun({ client, jobs, target, concurrency: target instanceof FolderTarget ? 3 : 2, skipExisting: skip });
    app.activeDownload = run;
    app.emit('download', true);

    const bar = h('div', { class: 'progress-bar' });
    const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': t('download.downloading') }, bar);
    const headline = h('p', { class: 'dl-headline', text: t('download.savingTo', { label: target.label }) });
    const stats = h('p', { class: 'muted small dl-stats' });
    const rows = new Map();
    const list = h('div', { class: 'dl-list' });
    for (const job of jobs) {
      const row = h(
        'div',
        { class: 'dl-row' },
        h('span', { class: 'dl-icon' }),
        h('span', { class: 'dl-name', text: job.name || job.asset.title || job.fallbackName, title: job.asset.href }),
        h('span', { class: 'dl-state' }),
        h('span', { class: 'dl-error', hidden: true }),
      );
      rows.set(job, row);
      list.append(row);
    }
    dialog.setTitle(t('download.downloading'));
    clear(dialog.body).append(h('div', { class: 'form' }, headline, progress, stats, list));
    const cancelButton = button(t('download.cancelDownload'), { variant: 'ghost', class: 'is-danger', onClick: requestCancel });
    dialog.setFooter(cancelButton);

    const samples = [];
    const renderRow = (job) => {
      const [iconEl, nameEl, stateEl, errorEl] = rows.get(job).children;
      rows.get(job).dataset.status = job.status;
      iconEl.replaceChildren(STATUS_ICONS[job.status] ? icon(STATUS_ICONS[job.status], { size: 16 }) : '');
      if (job.name) nameEl.textContent = job.name;
      let state = '';
      if (job.status === 'active') state = job.total ? t('download.receivedOfTotal', { received: formatBytes(job.received), total: formatBytes(job.total) }) : formatBytes(job.received);
      else if (job.status === 'done') state = formatBytes(job.total || job.received);
      else if (job.status === 'skipped') state = t('download.alreadyThere');
      else if (job.status === 'failed') state = t('download.failed');
      else if (job.status === 'cancelled') state = t('download.cancelled');
      else if (job.total) state = formatBytes(job.total);
      stateEl.textContent = state;
      errorEl.hidden = job.status !== 'failed';
      errorEl.textContent = job.error || '';
    };
    const renderTotals = () => {
      const fraction = run.fraction();
      bar.style.width = `${(fraction * 100).toFixed(1)}%`;
      progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
      const c = run.counts();
      const settled = c.done + c.skipped + c.failed + c.cancelled;
      const now = performance.now();
      samples.push([now, run.bytesDone]);
      while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
      const [t0, b0] = samples[0];
      const rate = now - t0 > 800 ? ((run.bytesDone - b0) * 1000) / (now - t0) : 0;
      const remainingBytes = jobs.every((j) => j.total) ? jobs.reduce((sum, j) => sum + Math.max(0, (j.total || 0) - (['done', 'skipped'].includes(j.status) ? j.total : j.received)), 0) : null;
      const parts = [tn('download.settledOfTotal', c.total, { settled }), formatBytes(run.bytesDone)];
      if (rate > 0 && settled < c.total) {
        parts.push(t('download.perSecond', { rate: formatBytes(rate) }));
        if (remainingBytes) parts.push(t('download.aboutLeft', { duration: formatDuration(remainingBytes / rate) }));
      }
      stats.textContent = parts.join(' · ');
    };
    for (const job of jobs) renderRow(job);
    renderTotals();

    const dirty = new Set();
    let frame = 0;
    const schedule = (job) => {
      dirty.add(job);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const j of dirty) renderRow(j);
        dirty.clear();
        renderTotals();
      });
    };
    run.on('job', schedule);
    run.on('progress', schedule);
    const ticker = setInterval(renderTotals, 1000);

    run.start().then((result) => finish(result), (err) => finish({ ...run.counts(), error: err }))
      .finally(() => clearInterval(ticker));

    function finish(result) {
      cancelAnimationFrame(frame);
      for (const j of jobs) renderRow(j);
      renderTotals();
      const finishedRun = run;
      run = null;
      app.activeDownload = null;
      app.emit('download', false);

      const pieces = [];
      if (result.done) pieces.push(tn('download.downloadedCount', result.done));
      if (result.skipped) pieces.push(t('download.alreadyInFolder', { n: result.skipped }));
      if (result.failed) pieces.push(t('download.failedCount', { n: result.failed }));
      if (result.cancelled) pieces.push(t('download.cancelledCount', { n: result.cancelled }));
      let headlineText = finishedRun.cancelled ? t('download.downloadCancelledHeadline') : result.failed ? t('download.finishedWithErrors') : t('download.downloadComplete');
      if (result.error) headlineText = t('download.downloadStopped', { message: result.error.message || result.error });
      headline.textContent = headlineText;
      if (result.archived) pieces.push(t('download.savedAsZip', { name: target.zipName }));
      stats.textContent = `${pieces.join(', ') || t('download.nothingDownloaded')}.`;
      bar.classList.toggle('is-error', Boolean(result.failed || result.error));

      const failed = jobs.filter((j) => j.status === 'failed');
      const footer = [];
      if (failed.length && !finishedRun.cancelled) {
        footer.push(button(tn('download.retryFailed', failed.length), {
          icon: 'refresh',
          onClick: () => {
            for (const job of failed) Object.assign(job, { status: 'queued', error: null, received: 0 });
            const retryTarget = target instanceof ZipTarget ? new ZipTarget(`${slug(api.name)}_${timestamp()}_retry.zip`) : target;
            runJobs(failed, retryTarget, skip);
          },
        }));
      }
      footer.push(button(t('common.close'), { variant: 'primary', onClick: () => dialog.close() }));
      dialog.setFooter(...footer);
    }
  }
}
