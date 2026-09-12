// Where downloaded bytes go. Each target hands out one WritableStream per file;
// the runner pipes the response into it. On success the stream is closed, which
// commits the file. On failure or cancel it is aborted, which discards it — so a
// cancelled batch never leaves half-written files behind.

import { t } from '../i18n/index.js';

/** Straight into a folder (File System Access API). Streams to disk; any size. */
export class FolderTarget {
  constructor(directory) {
    this.directory = directory;
    this.label = directory.name;
  }

  /** Size of an existing file called *name*, or null. */
  async existingSize(name) {
    try {
      const handle = await this.directory.getFileHandle(name);
      return (await handle.getFile()).size;
    } catch {
      return null;
    }
  }

  async open(name) {
    const handle = await this.directory.getFileHandle(name, { create: true });
    // Writes go to a swap file that only replaces the real one on close().
    return handle.createWritable();
  }

  async finish() {
    return null;
  }
}

/** Collect a file's chunks in memory; *onComplete(chunks)* runs when it closes. */
function memorySink(onComplete) {
  let chunks = [];
  return new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    },
    close() {
      onComplete(chunks);
      chunks = null;
    },
    abort() {
      chunks = null;
    },
  });
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Long enough for the browser to have taken over the blob.
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** Each file becomes its own browser download once complete. Held in memory until then. */
export class BrowserFilesTarget {
  constructor() {
    this.label = t('download.yourBrowserDownloads');
  }

  async existingSize() {
    return null;
  }

  async open(name, type) {
    return memorySink((chunks) => saveBlob(new Blob(chunks, { type: type || 'application/octet-stream' }), name));
  }

  async finish() {
    return null;
  }
}

/**
 * Every file in one uncompressed ZIP, saved when the batch ends. Files are added
 * whole, after they have downloaded, so a failed or cancelled file never
 * leaves a truncated entry. The archive is built in memory, and fflate writes no
 * ZIP64, so the caller must keep batches well under 4 GB.
 */
export class ZipTarget {
  constructor(zipName) {
    this.zipName = zipName;
    this.label = zipName;
    this.parts = [];
    this.count = 0;
    this.ready = import('../../vendor/fflate/fflate.js').then(({ Zip, ZipPassThrough }) => {
      this.ZipPassThrough = ZipPassThrough;
      this.zip = new Zip((error, data) => {
        if (error) this.error = error;
        else this.parts.push(data);
      });
    });
  }

  async existingSize() {
    return null;
  }

  async open(name) {
    await this.ready;
    return memorySink((chunks) => {
      // Stored, not deflated: the assets are almost all compressed already.
      const entry = new this.ZipPassThrough(name);
      entry.mtime = new Date();
      this.zip.add(entry);
      for (let i = 0; i < chunks.length; i++) entry.push(chunks[i], i === chunks.length - 1);
      if (!chunks.length) entry.push(new Uint8Array(0), true);
      this.count++;
    });
  }

  /** Close the archive and hand it to the browser. Returns the file count. */
  async finish() {
    await this.ready;
    if (!this.count) return 0;
    this.zip.end();
    if (this.error) throw this.error;
    saveBlob(new Blob(this.parts, { type: 'application/zip' }), this.zipName);
    this.parts = [];
    return this.count;
  }
}
