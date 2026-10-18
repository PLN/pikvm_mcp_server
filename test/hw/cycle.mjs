// Modified 2026-10 by PLN: hardware suite MSD cycle and cleanup (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: cleanup deletes only this run's image names (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: restore a leftover image this run did not create (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: cleanup logs go through redactUrl (GPL-3.0; see NOTICE).

/**
 * Upload, mount, eject, and remove one mcp-hwtest image through the tools.
 * The finally block disconnects a drive this cycle connected, removes
 * only the image names this run created, and restores the snapshot.
 * A selected image this run did not create is restored, including a
 * leftover mcp-hwtest-* name. Any other mcp-hwtest-* name is logged
 * and left in place. A forced failure still runs the finally block.
 */

import { inspectFetchUrl, redactUrl } from '../../dist/url-policy.js';
import { isHwTestImageName } from './media.mjs';

function toolText(result) {
  return result?.content?.[0]?.text ?? '';
}

async function callJson(call, name, args) {
  const result = await call(name, args);
  const text = toolText(result);
  if (result?.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function snapshotFrom(status) {
  const drive = status?.drive;
  return {
    image: drive?.image?.name ?? '',
    cdrom: drive?.cdrom === true,
    rw: drive?.rw === true,
    connected: drive?.connected === true,
    busy: status?.busy === true,
  };
}

async function pollJob(call, jobId, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const job = await callJson(call, 'pikvm_msd_job', { jobId });
    if (job.state === 'done') return job;
    if (job.state === 'failed') {
      throw new Error(`job ${jobId} failed: ${JSON.stringify(job.error ?? job)}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`job ${jobId} still ${job.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function cleanup(call, snap, created, client, log) {
  const errors = [];
  const note = (err) => {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  };
  let status;
  try {
    status = await callJson(call, 'pikvm_msd_status', {});
  } catch (err) {
    note(err);
  }
  if (status?.drive?.connected === true) {
    const selected = status.drive.image?.name ?? '';
    try {
      await callJson(call, 'pikvm_msd_eject', { expectImage: selected });
      log('hw: cleanup disconnected the drive');
    } catch (err) {
      note(err);
    }
  }
  try {
    status = await callJson(call, 'pikvm_msd_status', {});
  } catch (err) {
    note(err);
  }
  const names = Object.keys(status?.images ?? {});
  for (const name of names) {
    if (!created.has(name)) continue;
    try {
      await callJson(call, 'pikvm_msd_remove', { image: name, confirmImage: name });
      log(`hw: cleanup removed ${name}`);
    } catch (err) {
      note(err);
    }
  }
  const mode = snap.cdrom ? 'cdrom' : 'flash';
  const rw = snap.cdrom ? false : snap.rw;
  if (snap.image && !created.has(snap.image)) {
    try {
      await callJson(call, 'pikvm_msd_mount', {
        image: snap.image,
        confirmImage: snap.image,
        mode,
        rw,
        connect: snap.connected,
      });
      log(
        `hw: cleanup restored ${snap.image} connected=${snap.connected} `
        + `cdrom=${snap.cdrom} rw=${snap.rw}`,
      );
    } catch (err) {
      note(err);
    }
  } else if (!snap.image) {
    if (!client) {
      note(new Error('cleanup has no client to restore cdrom and rw'));
    } else {
      try {
        await client.msdSetParams({ cdrom: snap.cdrom, rw });
        log(`hw: cleanup restored cdrom=${snap.cdrom} rw=${snap.rw}`);
      } catch (err) {
        note(err);
      }
    }
  }
  let finalStatus;
  try {
    finalStatus = await callJson(call, 'pikvm_msd_status', {});
  } catch (err) {
    note(err);
  }
  const leftovers = Object.keys(finalStatus?.images ?? {}).filter(
    (name) => isHwTestImageName(name) && !created.has(name),
  );
  if (leftovers.length === 0) log('hw: no mcp-hwtest images left');
  else log(`hw: leftover mcp-hwtest images: ${leftovers.join(', ')}`);
  for (const err of errors) log(`hw: cleanup error: ${redactUrl(err.message)}`);
  return { errors, leftovers, finalStatus };
}

export async function runMsdWriteCycle(call, options) {
  const log = options.log ?? ((line) => console.log(line));
  const timeoutMs = options.timeoutMs ?? 120000;
  const allow = options.allow;
  if (options.fetchUrl) {
    inspectFetchUrl(options.fetchUrl, options.allowlist);
  }
  const status = await callJson(call, 'pikvm_msd_status', {});
  const snap = snapshotFrom(status);
  log(
    `hw: snapshot image=${JSON.stringify(snap.image)} connected=${snap.connected} `
    + `cdrom=${snap.cdrom} rw=${snap.rw} busy=${snap.busy}`,
  );
  if ((snap.connected || snap.busy) && allow !== 'force') {
    const why = [];
    if (snap.connected) why.push('the drive is connected');
    if (snap.busy) why.push('the drive is busy');
    return {
      skipped: true,
      reason: `${why.join(' and ')}; refusing to change it. `
        + 'PIKVM_HW_TEST_ALLOW_MSD=force overrides this and is dangerous',
    };
  }
  const created = new Set();
  if (options.imageName) created.add(options.imageName);
  if (options.fetchImageName) created.add(options.fetchImageName);
  let failure;
  let cleaned;
  try {
    if (snap.connected && allow === 'force') {
      log('hw: PIKVM_HW_TEST_ALLOW_MSD=force disconnects the current drive');
      await callJson(call, 'pikvm_msd_eject', { expectImage: snap.image });
    }
    const uploaded = await callJson(call, 'pikvm_msd_upload', {
      file: options.imageName,
      confirmImage: options.imageName,
    });
    await pollJob(call, uploaded.jobId, timeoutMs);
    const cdrom = {
      image: options.imageName,
      confirmImage: options.imageName,
      mode: 'cdrom',
      rw: false,
      connect: true,
    };
    // Only the force path, which already disconnected, names the previous
    // image. Omitting expectImage makes a drive connected after the
    // snapshot a refusal instead of a disconnect.
    if (snap.connected) cdrom.expectImage = snap.image;
    await callJson(call, 'pikvm_msd_mount', cdrom);
    if (options.failAfter === 'mount-cdrom') {
      throw new Error('forced failure');
    }
    const first = await callJson(call, 'pikvm_msd_eject', { expectImage: options.imageName });
    if (first.alreadyDisconnected !== false) {
      throw new Error('first eject was already disconnected');
    }
    const selected = first.drive?.image?.name ?? '';
    const second = await callJson(call, 'pikvm_msd_eject', { expectImage: selected });
    if (second.alreadyDisconnected !== true) {
      throw new Error('second eject was not alreadyDisconnected');
    }
    const flash = {
      image: options.imageName,
      confirmImage: options.imageName,
      mode: 'flash',
      rw: false,
      connect: true,
    };
    const afterEject = second.drive?.image?.name ?? '';
    if (afterEject !== '') flash.expectImage = afterEject;
    const mountedFlash = await callJson(call, 'pikvm_msd_mount', flash);
    const flashImage = mountedFlash.drive?.image?.name ?? options.imageName;
    await callJson(call, 'pikvm_msd_eject', { expectImage: flashImage });
    await callJson(call, 'pikvm_msd_remove', {
      image: options.imageName,
      confirmImage: options.imageName,
    });
    if (options.fetchUrl) {
      const fetchImage = options.fetchImageName;
      const started = await callJson(call, 'pikvm_msd_fetch_url', {
        url: options.fetchUrl,
        image: fetchImage,
        confirmImage: fetchImage,
      });
      await pollJob(call, started.jobId, timeoutMs);
      await callJson(call, 'pikvm_msd_remove', {
        image: fetchImage,
        confirmImage: fetchImage,
      });
    }
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    cleaned = await cleanup(call, snap, created, options.client, log);
  }
  if (cleaned.errors.length > 0) {
    const summary = cleaned.errors.map((err) => redactUrl(err.message)).join('; ');
    if (failure) failure.message += `; cleanup failed: ${summary}`;
    else failure = new Error(`cleanup failed: ${summary}`);
  }
  if (failure) throw failure;
  return { skipped: false, leftovers: cleaned.leftovers, drive: cleaned.finalStatus?.drive ?? null };
}
