// Planning and running a batch download.

import { t } from '../i18n/index.js';
import { Emitter } from '../lib/emitter.js';
import { NetworkError, isAbort } from '../lib/http.js';
import { filenameFromDisposition, filenameFromUrl, sanitizeFilename, uniqueName, withExtension } from './filenames.js';

/** Every downloadable asset of *items*, as { item, asset } entries. */
export function entriesFor(items) {
  return items.flatMap((item) => item.downloadable.map((asset) => ({ item, asset })));
}

/**
 * One job per distinct asset href across *entries* ({ item, asset }). Several
 * items routinely link the same file — an NGP Detaljplan document belongs to
 * every item it describes — and fetching it once per item would only rewrite
 * the same file. The first item to reference an href names the job.
 */
export function planDownload(entries) {
  const jobs = [];
  const seen = new Set();
  let references = 0;
  for (const { item, asset } of entries) {
    references++;
    if (seen.has(asset.href)) continue;
    seen.add(asset.href);
    jobs.push({
      index: jobs.length,
      item,
      asset,
      fallbackName: `${item.id}_${asset.key}`,
      expected: asset.size,
      name: null,
      status: 'queued', // queued | active | done | skipped | failed | cancelled
      received: 0,
      total: asset.size,
      error: null,
    });
  }
  const sized = jobs.filter((j) => j.expected !== null);
  return {
    jobs,
    duplicates: references - jobs.length,
    knownBytes: sized.reduce((sum, j) => sum + j.expected, 0),
    unknownSizes: jobs.length - sized.length,
  };
}

/**
 * Runs jobs against a target with bounded concurrency. Emits 'progress' as bytes
 * arrive (callers should throttle rendering) and 'job' when a job changes state.
 */
export class DownloadRun extends Emitter {
  #controller = new AbortController();
  #taken = new Set();

  constructor({ client, jobs, target, concurrency = 3, skipExisting = false }) {
    super();
    this.client = client;
    this.jobs = jobs;
    this.target = target;
    this.concurrency = concurrency;
    this.skipExisting = skipExisting;
    this.bytesDone = 0;
    this.cancelled = false;
    this.startedAt = 0;
  }

  get signal() {
    return this.#controller.signal;
  }

  cancel() {
    this.cancelled = true;
    this.#controller.abort();
  }

  /** Run every queued job. Resolves to counts once all have settled. */
  async start() {
    this.startedAt = performance.now();
    const queue = this.jobs.filter((j) => j.status === 'queued');
    const worker = async () => {
      while (queue.length && !this.cancelled) await this.#run(queue.shift());
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    for (const job of this.jobs) if (job.status === 'queued') this.#set(job, 'cancelled');

    let archived = null;
    if (!this.cancelled) archived = await this.target.finish();
    return { ...this.counts(), archived };
  }

  counts() {
    const counts = { done: 0, skipped: 0, failed: 0, cancelled: 0, total: this.jobs.length };
    for (const job of this.jobs) if (job.status in counts) counts[job.status]++;
    return counts;
  }

  /** Overall fraction 0–1: by bytes when every size is known, otherwise by files. */
  fraction() {
    const settled = (j) => j.status === 'done' || j.status === 'skipped' || j.status === 'failed' || j.status === 'cancelled';
    if (this.jobs.every((j) => j.total || settled(j))) {
      let done = 0;
      let total = 0;
      for (const j of this.jobs) {
        const size = j.total || 0;
        total += size;
        done += settled(j) ? size : Math.min(j.received, size);
      }
      return total ? done / total : 1;
    }
    let units = 0;
    for (const j of this.jobs) {
      if (settled(j)) units += 1;
      else if (j.status === 'active' && j.total) units += Math.min(1, j.received / j.total);
    }
    return this.jobs.length ? units / this.jobs.length : 1;
  }

  async #run(job) {
    this.#set(job, 'active');
    job.received = 0;
    try {
      const response = await this.client.openAsset(job.asset, { signal: this.signal });
      const length = Number(response.headers.get('Content-Length')) || null;
      if (length && !response.headers.get('Content-Encoding')) job.total = length;

      const type = response.headers.get('Content-Type') || job.asset.type;
      // A STAC asset that is actually a link to a web page (NGP's
      // Kulturhistoriska Lämningar does this) downloads as an HTML document
      // instead of the file its title promises. Only detectable by fetching
      // it, so this only surfaces once the user tries.
      if (/^text\/html\b/i.test(type)) {
        await response.body?.cancel();
        job.error = t('download.assetIsWebPageError');
        this.#set(job, 'failed');
        return;
      }
      const suggested = filenameFromDisposition(response.headers.get('Content-Disposition'))
        || filenameFromUrl(job.asset.href)
        || job.fallbackName;
      job.name = uniqueName(sanitizeFilename(withExtension(suggested, type), job.fallbackName), this.#taken);
      this.emit('job', job);

      if (this.skipExisting && job.total) {
        const existing = await this.target.existingSize(job.name);
        if (existing === job.total) {
          await response.body?.cancel();
          job.received = job.total;
          this.#set(job, 'skipped');
          return;
        }
      }

      const sink = await this.target.open(job.name, type);
      const counter = new TransformStream({
        transform: (chunk, controller) => {
          job.received += chunk.byteLength;
          this.bytesDone += chunk.byteLength;
          this.emit('progress', job);
          controller.enqueue(chunk);
        },
      });
      if (response.body) await response.body.pipeThrough(counter).pipeTo(sink, { signal: this.signal });
      else await sink.close();
      if (!job.total) job.total = job.received;
      this.#set(job, 'done');
    } catch (error) {
      if (isAbort(error) || this.cancelled) {
        this.#set(job, 'cancelled');
      } else {
        // A browser can't tell "wrong credentials" from "network trouble" here:
        // a server that omits CORS headers on its error responses makes an
        // unauthorized request look identical to one that never got there. The
        // former is far more common in practice, so lead with it.
        job.error = error instanceof NetworkError ? t('download.assetNetworkError') : (error?.message || String(error));
        this.#set(job, 'failed');
      }
    }
  }

  #set(job, status) {
    job.status = status;
    this.emit('job', job);
  }
}
