// Modified 2026-10 by PLN: hardware suite MSD cycle and cleanup (GPL-3.0; see NOTICE).

/**
 * Upload, mount, eject, and remove one mcp-hwtest image through the tools.
 * The finally block disconnects a drive this cycle connected, removes
 * every storage name that starts with mcp-hwtest-, and remounts the
 * snapshot image when that image was connected. Names that do not have
 * that prefix are left alone. A forced failure still runs the finally block.
 */

import { inspectFetchUrl } from '../../dist/url-policy.js';
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

async function cleanup(call, snap, log) {
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
    if (!isHwTestImageName(name)) continue;
    try {
      await callJson(call, 'pikvm_msd_remove', { image: name, confirmImage: name });
      log(`hw: cleanup removed ${name}`);
    } catch (err) {
      note(err);
    }
  }
  if (snap.image && !isHwTestImageName(snap.image)) {
    try {
      await callJson(call, 'pikvm_msd_mount', {
        image: snap.image,
        confirmImage: snap.image,
        mode: snap.cdrom ? 'cdrom' : 'flash',
        rw: snap.cdrom ? false : snap.rw,
        connect: snap.connected,
      });
      log(
        `hw: cleanup restored ${snap.image} connected=${snap.connected} `
        + `cdrom=${snap.cdrom} rw=${snap.rw}`,
      );
    } catch (err) {
      note(err);
    }
  }
  let finalStatus;
  try {
    finalStatus = await callJson(call, 'pikvm_msd_status', {});
  } catch (err) {
    note(err);
  }
  const leftovers = Object.keys(finalStatus?.images ?? {}).filter(isHwTestImageName);
  if (leftovers.length === 0) log('hw: no mcp-hwtest images left');
  else log(`hw: leftover mcp-hwtest images: ${leftovers.join(', ')}`);
  for (const err of errors) log(`hw: cleanup error: ${err.message}`);
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
      expectImage: snap.image,
    };
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
    cleaned = await cleanup(call, snap, log);
  }
  if (cleaned.errors.length > 0) {
    const summary = cleaned.errors.map((err) => err.message).join('; ');
    if (failure) failure.message += `; cleanup failed: ${summary}`;
    else failure = new Error(`cleanup failed: ${summary}`);
  }
  if (failure) throw failure;
  return { skipped: false, leftovers: cleaned.leftovers, drive: cleaned.finalStatus?.drive ?? null };
}
