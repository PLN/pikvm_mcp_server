// Modified 2026-10 by PLN: MSD mount and eject policy (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: expectImage, preflight, and MSD mutex (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload jobs, remove, and job lock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hashing jobs, bad-image cleanup, upload try-lock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: URL fetch jobs and mount block during a transfer (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: fetch cleanup only after our progress line (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: redactUrl on MSD errors (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: close the upload file handle once (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: fh.close waits for the in-flight read (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: job reads stay on the device that created them (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the retained-job cap is per device (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: catalog readiness after a successful write (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a stable wrong size fails at once, and an unseen image is confirmed briefly (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the upload slot is free before a job looks finished (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: eject expectImage is typed, and catalog cleanup keeps the MSD lock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash reads stop at the MSD job ceiling (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash timeout releases the upload slot before close (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash reads use the idle timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: catalog budgets use a monotonic clock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a catalog read is not started with under 1 ms left (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: tests can see one catalog read and the upload slot (GPL-3.0; see NOTICE).

/**
 * Policy for MSD status, mount, eject, upload, and remove.
 * Plain kvmd calls stay on the client. Echo-back checks, preflight,
 * and mount rollback live here.
 * Mount and eject share a per-device mutex so one session's rollback
 * cannot run in the middle of another's change. An upload takes a
 * fail-fast try-lock, so a second upload or URL fetch is refused and a
 * transfer does not queue mount or eject. Mount refuses an image that
 * already has an active transfer. After a successful write, the catalog
 * wait holds that mutex until the image is ready, or until cleanup after
 * that wait fails has finished.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs, { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  KvmdError,
  msdIdleTimeoutOf,
  msdJobTimeoutOf,
  type MsdDriveState,
  type MsdImageRecord,
  type MsdState,
  type MsdWriteResult,
  type PiKVMClient,
} from './pikvm/client.js';
import {
  MSD_READY_TIMEOUT_DEFAULT_MS,
  MSD_READY_TIMEOUT_MAX_MS,
  MSD_UNSEEN_CONFIRM_MS,
  normalizeMsdTimeoutMs,
} from './request-timeout.js';
import {
  assertResolvedAddresses,
  inspectFetchUrl,
  MsdUrlPolicyError,
  redactUrl,
  resolveFetchHost,
  type UrlAllowlist,
} from './url-policy.js';

export interface ResolvedDevice {
  name: string;
  client: PiKVMClient;
}

/**
 * Single-client helper. The server resolves a fleet device instead.
 * The hardware skip test still checks that `{ device: 'default' }`
 * returns this client unchanged.
 */
export function resolveDevice(
  _args: { device?: unknown },
  client: PiKVMClient,
): ResolvedDevice {
  return { name: 'default', client };
}

const msdLockTail = new Map<string, Promise<void>>();

/**
 * One MSD mutation at a time for a device. Separate from BusyLock, which
 * only covers auto-calibration and is not shared the same way across
 * HTTP sessions. The tail is the device key from resolveDevice.
 */
export function withMsdLock<T>(device: string, run: () => Promise<T>): Promise<T> {
  const previous = msdLockTail.get(device) ?? Promise.resolve();
  let settled!: Promise<void>;
  const runPromise = previous.then(run, run);
  settled = runPromise.then(() => {
    if (msdLockTail.get(device) === settled) msdLockTail.delete(device);
  }, () => {
    if (msdLockTail.get(device) === settled) msdLockTail.delete(device);
  });
  msdLockTail.set(device, settled);
  return runPromise;
}

export interface DriveSnapshot {
  image: string;
  cdrom: boolean;
  rw: boolean;
  connected: boolean;
}

export interface ErrorFields {
  status: number;
  type: string;
  message: string;
  endpoint: string;
}

/**
 * expectImage does not match the snapshot image. That includes a value
 * supplied while the drive is disconnected. Mount must not change the drive.
 */
export class MsdExpectImageError extends Error {
  readonly type = 'MsdExpectImageError';
  readonly image: string;

  constructor(image: string) {
    super(`drive image is ${JSON.stringify(image)}; expectImage must equal that name`);
    this.name = 'MsdExpectImageError';
    this.image = image;
  }
}

/** A kvmd state check refused the upload or the removal before any POST. */
export class MsdPreflightError extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(message);
    this.name = type;
    this.type = type;
  }
}

/** Another upload or URL fetch already holds this device. The caller is not queued. */
export class MsdUploadBusyError extends Error {
  readonly type = 'MsdUploadBusyError';

  constructor() {
    super('upload already running');
    this.name = 'MsdUploadBusyError';
  }
}

/**
 * The write was accepted. The image was still absent, or its catalog
 * row was not yet a size and a complete flag, when the budget ended.
 * The upload POST is not repeated. The image may still appear.
 */
export class MsdCatalogTimeoutError extends Error {
  readonly type = 'PIKVM_MSD_CATALOG_TIMEOUT';

  constructor(image: string) {
    super(`write of ${JSON.stringify(image)} was accepted; the image may still appear`);
    this.name = 'MsdCatalogTimeoutError';
  }
}

/** The catalog row is present and complete is false when the budget ends. */
export class MsdImageIncompleteError extends Error {
  readonly type = 'PIKVM_MSD_IMAGE_INCOMPLETE';

  constructor(image: string) {
    super(`image ${JSON.stringify(image)} is incomplete after upload`);
    this.name = 'MsdImageIncompleteError';
  }
}

/** The catalog row is present and its size is not the byte count we wrote. */
export class MsdSizeMismatchError extends Error {
  readonly type = 'PIKVM_MSD_SIZE_MISMATCH';

  constructor(image: string, actual: number, expected: number) {
    super(`image ${JSON.stringify(image)} size is ${actual}, expected ${expected}`);
    this.name = 'MsdSizeMismatchError';
  }
}

/**
 * Hashing did not finish before PIKVM_MSD_JOB_TIMEOUT_MS.
 * The upload POST is not sent. The slot is released without waiting
 * for the file to close. The descriptor is closed once no hash read
 * is in flight.
 */
export class MsdHashTimeoutError extends Error {
  readonly type = 'PIKVM_MSD_HASH_TIMEOUT';

  constructor(ms: number) {
    super(`hash timeout after ${ms}ms`);
    this.name = 'MsdHashTimeoutError';
  }
}

/**
 * One hash read returned no bytes for PIKVM_MSD_IDLE_TIMEOUT_MS.
 * This is not the job wall clock. The upload POST is not sent.
 * The slot is released without waiting for the file to close.
 * The descriptor is closed once no hash read is in flight.
 */
export class MsdHashIdleTimeoutError extends Error {
  readonly type = 'PIKVM_MSD_HASH_IDLE_TIMEOUT';

  constructor(file: string, ms: number) {
    super(`hash of ${JSON.stringify(file)} made no progress for ${ms}ms (PIKVM_MSD_IDLE_TIMEOUT_MS)`);
    this.name = 'MsdHashIdleTimeoutError';
  }
}

/** Cancelled while waiting for the catalog. The write is not sent again. */
export class MsdCancelledError extends Error {
  readonly type = 'PIKVM_MSD_CANCELLED';

  constructor(image: string) {
    super(`catalog wait for ${JSON.stringify(image)} was cancelled`);
    this.name = 'MsdCancelledError';
  }
}

/**
 * The image was still in the catalog when the removal budget ended,
 * or a remove failed for a reason other than an unknown name.
 */
export class MsdRemovalUnconfirmedError extends Error {
  readonly type = 'PIKVM_MSD_REMOVAL_UNCONFIRMED';

  constructor(image: string) {
    super(`removal of ${JSON.stringify(image)} was not confirmed`);
    this.name = 'MsdRemovalUnconfirmedError';
  }
}

/** Mount of an image that still has an upload or fetch job. No kvmd call is made. */
export class MsdImageTransferError extends Error {
  readonly type = 'MsdImageTransferError';
  readonly image: string;

  constructor(image: string) {
    super(`image ${JSON.stringify(image)} has an active transfer`);
    this.name = 'MsdImageTransferError';
    this.image = image;
  }
}

export interface EjectResult {
  drive: MsdDriveState | null;
  alreadyDisconnected: boolean;
}

export interface MountRequest {
  device: string;
  image: string;
  confirmImage: string;
  mode: 'cdrom' | 'flash';
  rw: boolean;
  connect: boolean;
  /** Required when the drive is already connected. Compared to the snapshot image. */
  expectImage?: string;
}

export interface MountSuccess {
  drive: MsdDriveState | null;
}

export interface MountFailure {
  error: ErrorFields;
  restored: MsdDriveState | null;
  /**
   * One entry per failed step, including the re-read. An NBD or URL
   * snapshot adds a synthetic entry because that image cannot be restored.
   * Omitted when every step succeeded.
   */
  rollbackError?: ErrorFields[];
}

export type MountResult = MountSuccess | MountFailure;

/** Fields the status tool returns. `enabled` is not part of that result. */
export function publicMsdState(state: MsdState): Omit<MsdState, 'enabled'> {
  return {
    online: state.online,
    busy: state.busy,
    drive: state.drive,
    images: state.images,
    parts: state.parts,
    free: state.free,
    uploading: state.uploading,
    downloading: state.downloading,
  };
}

function imageName(drive: MsdDriveState | null): string {
  return drive?.image?.name ?? '';
}

function snapshotOf(drive: MsdDriveState | null): DriveSnapshot {
  return {
    image: imageName(drive),
    cdrom: drive?.cdrom === true,
    rw: drive?.rw === true,
    connected: drive?.connected === true,
  };
}

function errorFields(err: unknown): ErrorFields {
  if (err instanceof KvmdError) {
    return {
      status: err.status,
      type: err.type,
      message: redactUrl(err.message),
      endpoint: err.endpoint,
    };
  }
  if (
    err instanceof MsdExpectImageError
    || err instanceof MsdPreflightError
    || err instanceof MsdUploadBusyError
    || err instanceof MsdImageTransferError
    || err instanceof MsdUrlPolicyError
    || err instanceof MsdCatalogTimeoutError
    || err instanceof MsdImageIncompleteError
    || err instanceof MsdSizeMismatchError
    || err instanceof MsdCancelledError
    || err instanceof MsdHashTimeoutError
    || err instanceof MsdHashIdleTimeoutError
    || err instanceof MsdRemovalUnconfirmedError
  ) {
    return {
      status: 0,
      type: err.type,
      message: redactUrl(err.message),
      endpoint: '',
    };
  }
  return {
    status: 0,
    type: 'Error',
    message: redactUrl(err instanceof Error ? err.message : 'MSD operation failed'),
    endpoint: '',
  };
}

function logImage(image: string): string {
  if (image.includes('/') || image.includes('\\') || image.includes('\0') || image.includes('://')) {
    return '';
  }
  return image;
}

function logMsd(
  event: string,
  device: string,
  image: string,
  ok: boolean,
  error?: string,
  extra?: Record<string, string | number | boolean>,
): void {
  const line: Record<string, unknown> = {
    event,
    device,
    image: logImage(image),
    ok,
  };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'path' || key === 'file' || key === 'url') continue;
      line[key] = value;
    }
  }
  if (error) line.error = error;
  console.error(JSON.stringify(line));
}

/**
 * Disconnect. kvmd raises MsdDisconnectedError when the drive is already
 * disconnected. That is success when a re-read shows connected === false.
 */
async function disconnect(client: PiKVMClient): Promise<void> {
  try {
    await client.msdSetConnected(false);
  } catch (err) {
    if (err instanceof KvmdError && err.type === 'MsdDisconnectedError') {
      const state = await client.getMsdState();
      if (state.drive == null || state.drive.connected === false) return;
    }
    throw err;
  }
}

/**
 * Restores the snapshot. An NBD or other URL selected as the drive image
 * cannot be restored: msdSetParams refuses any name containing '://' and
 * does not send it. That refusal is a rollbackError entry, as is a
 * failure of the final state re-read. The previous URL image stays
 * unrestored.
 */
async function rollback(
  client: PiKVMClient,
  snap: DriveSnapshot,
): Promise<{ drive: MsdDriveState | null; rollbackError?: ErrorFields[] }> {
  const rollbackError: ErrorFields[] = [];
  const note = (err: unknown) => {
    rollbackError.push(errorFields(err));
  };
  try {
    await disconnect(client);
  } catch (err) {
    note(err);
  }
  if (snap.image.includes('://')) {
    note(new Error(
      `cannot restore snapshot image ${JSON.stringify(snap.image)}; msdSetParams refuses URLs`,
    ));
  } else {
    try {
      await client.msdSetParams({
        image: snap.image,
        cdrom: snap.cdrom,
        rw: snap.rw,
      });
    } catch (err) {
      note(err);
    }
  }
  if (snap.connected) {
    try {
      await client.msdSetConnected(true);
    } catch (err) {
      note(err);
    }
  }
  let drive: MsdDriveState | null = null;
  try {
    drive = (await client.getMsdState()).drive;
  } catch (err) {
    note(err);
  }
  return rollbackError.length > 0 ? { drive, rollbackError } : { drive };
}

async function ejectMsdLocked(
  client: PiKVMClient,
  expectImage: string,
  device: string,
): Promise<EjectResult> {
  const state = await client.getMsdState();
  const current = imageName(state.drive);
  if (current !== expectImage) {
    throw new MsdExpectImageError(current);
  }
  try {
    await client.msdSetConnected(false);
  } catch (err) {
    if (err instanceof KvmdError && err.type === 'MsdDisconnectedError') {
      const again = await client.getMsdState();
      if (again.drive == null || again.drive.connected === false) {
        logMsd('msd_eject', device, expectImage, true);
        return { drive: again.drive, alreadyDisconnected: true };
      }
    }
    logMsd('msd_eject', device, expectImage, false, errorFields(err).type);
    throw err;
  }
  const after = await client.getMsdState();
  logMsd('msd_eject', device, expectImage, true);
  return { drive: after.drive, alreadyDisconnected: false };
}

export function ejectMsd(
  client: PiKVMClient,
  expectImage: string,
  device: string,
): Promise<EjectResult> {
  return withMsdLock(device, () => ejectMsdLocked(client, expectImage, device));
}

async function mountMsdLocked(client: PiKVMClient, request: MountRequest): Promise<MountResult> {
  const { device, image, confirmImage, mode, rw, connect, expectImage } = request;
  if (confirmImage !== image) {
    throw new Error('confirmImage does not match image');
  }
  if (image.includes('://')) {
    throw new Error('image must not contain ://');
  }
  assertNoActiveTransfer(device, image);
  const state = await client.getMsdState();
  // Offline hides the drive, so there is no snapshot image to compare.
  if (!state.online) {
    throw new Error('kvmd MSD is offline');
  }
  const snap = snapshotOf(state.drive);
  // A connected drive always requires expectImage. A supplied expectImage
  // is also checked when nothing is connected, so it is not ignored.
  if ((snap.connected || expectImage !== undefined) && expectImage !== snap.image) {
    throw new MsdExpectImageError(snap.image);
  }
  if (state.busy) {
    throw new Error('kvmd MSD is busy');
  }
  const stored = state.images[image];
  if (!stored) {
    throw new Error(`image ${JSON.stringify(image)} is not in storage`);
  }
  if (stored.complete !== true) {
    throw new Error(`image ${JSON.stringify(image)} is incomplete`);
  }
  let started = false;
  try {
    if (snap.connected) {
      started = true;
      await disconnect(client);
    }
    started = true;
    // Send rw as requested. kvmd forces it false for cdrom and for an
    // image that is not writable. The re-read below is that result.
    await client.msdSetParams({
      image,
      cdrom: mode === 'cdrom',
      rw,
    });
    if (connect) await client.msdSetConnected(true);
    const drive = (await client.getMsdState()).drive;
    logMsd('msd_mount', device, image, true);
    return { drive };
  } catch (err) {
    if (!started) throw err;
    const rolled = await rollback(client, snap);
    logMsd('msd_mount', device, image, false, errorFields(err).type);
    const failure: MountFailure = {
      error: errorFields(err),
      restored: rolled.drive,
    };
    if (rolled.rollbackError) failure.rollbackError = rolled.rollbackError;
    return failure;
  }
}

export function mountMsd(client: PiKVMClient, request: MountRequest): Promise<MountResult> {
  return withMsdLock(request.device, () => mountMsdLocked(client, request));
}

/**
 * Devices with an upload in progress. A second upload fails immediately
 * instead of waiting behind a transfer. Mount and eject do not take this
 * set, and the byte transfer does not take withMsdLock or BusyLock.
 * The catalog wait after a successful write takes withMsdLock, and
 * cleanup after that wait fails stays inside the same hold.
 */
const uploadHeld = new Set<string>();

function acquireUpload(device: string): void {
  if (uploadHeld.has(device)) throw new MsdUploadBusyError();
  uploadHeld.add(device);
}

function releaseUpload(device: string): void {
  uploadHeld.delete(device);
}

/** True when no device holds the upload slot. Tests wait for this. It does not acquire or release. */
export function msdUploadSlotsFree(): boolean {
  return uploadHeld.size === 0;
}

const UPLOAD_POLL_MS = 1500;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const JOB_CAP = 64;
const CATALOG_POLL_MIN_MS = 250;
const CATALOG_POLL_MAX_MS = 2000;

type JobState = 'hashing' | 'running' | 'awaiting_catalog' | 'done' | 'failed';

export interface MsdJobView {
  state: JobState;
  bytes: number;
  total: number;
  sha256?: string;
  error?: ErrorFields;
  /** Set when a post-check failure tried to delete the stored image. */
  removed?: boolean;
  removeError?: ErrorFields;
}

interface JobRecord {
  state: JobState;
  bytes: number;
  total: number;
  device: string;
  image: string;
  sha256?: string;
  error?: ErrorFields;
  removed?: boolean;
  removeError?: ErrorFields;
  finishedAt?: number;
  abort: AbortController;
}

const jobs = new Map<string, JobRecord>();

function assertNoActiveTransfer(device: string, image: string): void {
  for (const job of jobs.values()) {
    if (job.device !== device || job.image !== image) continue;
    if (job.state === 'hashing' || job.state === 'running' || job.state === 'awaiting_catalog') {
      throw new MsdImageTransferError(image);
    }
  }
}

function jobLimitOf(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : JOB_CAP;
}

function jobTtlOf(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : JOB_TTL_MS;
}

/** Drop finished jobs older than the TTL, then each device's oldest finished jobs past the cap. */
function pruneJobs(limit: number, ttlMs: number): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > ttlMs) jobs.delete(id);
  }
  const names = new Set<string>();
  for (const job of jobs.values()) names.add(job.device);
  for (const device of names) {
    const owned = [...jobs.entries()].filter(([, job]) => job.device === device);
    if (owned.length <= limit) continue;
    const finished = owned.filter(([, job]) => job.finishedAt !== undefined);
    finished.sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
    let extra = owned.length - limit;
    for (const [id] of finished) {
      if (extra <= 0) break;
      jobs.delete(id);
      extra -= 1;
    }
  }
}

export interface JobReadOptions {
  jobLimit?: number;
  jobTtlMs?: number;
  /**
   * When set, a job stored for another device is not found.
   * The id stays a random 16-byte hex value. The miss matches an unknown id.
   */
  device?: string;
}

export function readMsdJob(jobId: string, options: JobReadOptions = {}): MsdJobView | undefined {
  pruneJobs(jobLimitOf(options.jobLimit), jobTtlOf(options.jobTtlMs));
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (options.device !== undefined && job.device !== options.device) return undefined;
  const view: MsdJobView = {
    state: job.state,
    bytes: job.bytes,
    total: job.total,
  };
  if (job.sha256 !== undefined) view.sha256 = job.sha256;
  if (job.error !== undefined) view.error = job.error;
  if (job.removed !== undefined) view.removed = job.removed;
  if (job.removeError !== undefined) view.removeError = job.removeError;
  return view;
}

export interface UploadRequest {
  device: string;
  localDir: string;
  maxBytes: number;
  extensions: readonly string[];
  file: string;
  confirmImage: string;
  sha256?: string;
  /** Awaited in the job before the hash. Unset in production. */
  beforeHash?: () => Promise<void>;
  /** Awaited in the upload body before the file is read. Unset in production. */
  beforeUploadStream?: () => Promise<void>;
  /**
   * Awaited after the file is closed, while the slot is still held, and
   * before the job becomes done or failed. It does not run on the
   * hash-timeout path: that path releases the slot before close.
   * Unset in production.
   */
  beforeSlotRelease?: () => Promise<void>;
  /**
   * Replaces fh.close for this job. Unset in production. The hook must
   * close the handle. A rejection is a close failure.
   */
  closeFile?: (fh: FileHandle) => Promise<void>;
  /** Overrides the 1.5s storage.uploading poll. Unset in production. */
  uploadPollMs?: number;
  /** Retained-job cap for one device. Default 64. Unset in production. */
  jobLimit?: number;
  /** Finished-job TTL in ms. Default 24h. Unset in production. */
  jobTtlMs?: number;
  /**
   * Catalog budget after a successful write. Unset uses
   * PIKVM_MSD_READY_TIMEOUT_MS (default 30s).
   */
  readyTimeoutMs?: number;
}

export interface RemoveResult {
  removed: true;
  drive: MsdDriveState | null;
}

function assertBareName(file: string, extensions: readonly string[]): void {
  if (file.length === 0 || file.length > 255 || file !== file.trim()) {
    throw new Error('file must be a bare image name');
  }
  if (
    file.includes('/')
    || file.includes('\\')
    || file.includes('\0')
    || file.startsWith('.')
    || file === 'lost+found'
  ) {
    throw new Error('file must be a bare image name');
  }
  for (let i = 0; i < file.length; i += 1) {
    const code = file.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) throw new Error('file must be a bare image name');
  }
  const lower = file.toLowerCase();
  if (!extensions.some((ext) => lower.endsWith(ext))) {
    throw new Error('file suffix is not allowed');
  }
}

function normalizeSha256(value: string): string {
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('sha256 must be 64 hex characters');
  return hex;
}

const HASH_CHUNK = 64 * 1024;

/**
 * Wall clock for hashing only. Cleared when hashing returns.
 * Same length as the upload POST ceiling, and it does not start that ceiling.
 * setTimeout overflows the same way AbortSignal.timeout does: a delay of
 * 2^31 ms or more fires after 1 ms. The timer is safe only because the
 * job ceiling is clamped to 7 days, which is under that limit.
 */
function startHashDeadline(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, ms);
  return {
    signal: ctrl.signal,
    done() {
      clearTimeout(timer);
    },
  };
}

/** One in-flight hash read, and the close the timeout deferred onto it. */
interface HashRead {
  pending: boolean;
  closeAfter: (() => void) | undefined;
}

/**
 * One positioned read. fs.read, not FileHandle.read: the handle read
 * holds a ref, and FileHandle.close then waits for that read. A hung
 * filesystem would keep the upload slot until the read returned.
 * Lookup is on the fs object so a test can replace fs.read.
 * After abort or the idle bound the late callback is ignored, so it
 * cannot reject twice. If a hash timeout deferred the close, that
 * same callback closes the fd. The idle timer covers this read only.
 * It is cleared when the read settles and does not limit the next one.
 */
function readSlice(
  fh: FileHandle,
  buf: Buffer,
  length: number,
  position: number,
  signal: AbortSignal,
  timeoutMs: number,
  hashRead: HashRead,
  idleMs: number,
  file: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MsdHashTimeoutError(timeoutMs));
      return;
    }
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = () => {
      if (idleTimer === undefined) return;
      clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearIdle();
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => {
      finish(() => reject(new MsdHashTimeoutError(timeoutMs)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // The idle cap is one hour, under the 2^31 ms timer limit.
    idleTimer = setTimeout(() => {
      finish(() => reject(new MsdHashIdleTimeoutError(file, idleMs)));
    }, idleMs);
    hashRead.pending = true;
    try {
      fs.read(fh.fd, buf, 0, length, position, (err, bytesRead) => {
        const closeAfter = hashRead.closeAfter;
        hashRead.pending = false;
        hashRead.closeAfter = undefined;
        finish(() => {
          if (err) reject(err);
          else resolve(bytesRead);
        });
        if (closeAfter) closeAfter();
      });
    } catch (err) {
      hashRead.pending = false;
      finish(() => reject(err));
    }
  });
}

/**
 * Hash-timeout close. A read still in flight closes from its own callback,
 * so close does not run beside that read. Otherwise close starts now.
 * The caller has already released the upload slot and does not wait.
 */
function closeWhenHashReadIdle(hashRead: HashRead, closeNow: () => void): void {
  if (hashRead.pending) {
    hashRead.closeAfter = closeNow;
    return;
  }
  closeNow();
}

async function hashFd(
  fh: FileHandle,
  size: number,
  signal: AbortSignal,
  timeoutMs: number,
  hashRead: HashRead,
  idleMs: number,
  file: string,
): Promise<string> {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(HASH_CHUNK);
  let offset = 0;
  while (offset < size) {
    if (signal.aborted) throw new MsdHashTimeoutError(timeoutMs);
    // A new read starts a new idle bound. Bytes from the previous
    // read are what reset it. idleMs is not a sum across reads.
    const bytesRead = await readSlice(
      fh,
      buf,
      Math.min(buf.length, size - offset),
      offset,
      signal,
      timeoutMs,
      hashRead,
      idleMs,
      file,
    );
    if (signal.aborted) throw new MsdHashTimeoutError(timeoutMs);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (signal.aborted) throw new MsdHashTimeoutError(timeoutMs);
  if (offset !== size) throw new Error('short read while hashing');
  return hash.digest('hex');
}

async function confine(
  localDir: string,
  file: string,
  maxBytes: number,
): Promise<{ fh: FileHandle; size: number }> {
  let root: string;
  try {
    root = await realpath(localDir);
  } catch {
    throw new Error('upload directory is not available');
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error('upload directory is not available');
  const candidate = path.join(root, file);
  let listed;
  try {
    listed = await lstat(candidate);
  } catch {
    throw new Error('file is not in the upload directory');
  }
  if (listed.isSymbolicLink()) throw new Error('symlink rejected');
  if (listed.isDirectory()) throw new Error('directory rejected');
  if (!listed.isFile()) throw new Error('not a regular file');
  let fh: FileHandle;
  try {
    fh = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error('upload path rejected');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size <= 0) throw new Error('file is empty');
    if (st.size > maxBytes) throw new Error('file exceeds PIKVM_MSD_MAX_BYTES');
    const resolved = await realpath(candidate);
    if (path.relative(root, resolved) !== file) throw new Error('upload path rejected');
    return { fh, size: st.size };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}

async function assertUploadAllowed(client: PiKVMClient, image: string, size: number): Promise<void> {
  const state = await client.getMsdState();
  if (!state.online) throw new MsdPreflightError('MsdOfflineError', 'kvmd MSD is offline');
  if (state.busy) throw new MsdPreflightError('MsdBusyError', 'kvmd MSD is busy');
  if (state.drive?.connected === true) throw new MsdPreflightError('MsdConnectedError', 'drive is connected');
  if (state.images[image]) throw new MsdPreflightError('MsdImageExistsError', 'image already exists');
  if (state.free === null || state.free < size) {
    throw new MsdPreflightError('MsdFreeSpaceError', 'free space is below the file size');
  }
}

/**
 * One owner. fh.createReadStream holds a ref on the handle.
 * The second close was the stream's delayed close after the
 * in-flight read. While a read is in flight, fh.close() waits for
 * that close rather than doing nothing, and the descriptor is
 * closed once, after the read. When the stream was never created,
 * only fh.close() runs.
 */
function closeUpload(
  stream: Readable | undefined,
  fh: FileHandle,
  closeFile?: (fh: FileHandle) => Promise<void>,
): Promise<void> {
  stream?.destroy();
  if (closeFile) return closeFile(fh);
  return fh.close();
}

function readyBudget(value: number | undefined): number {
  if (value === undefined) return MSD_READY_TIMEOUT_DEFAULT_MS;
  return normalizeMsdTimeoutMs(value, MSD_READY_TIMEOUT_DEFAULT_MS, MSD_READY_TIMEOUT_MAX_MS);
}

function throwIfCancelled(image: string, signal: AbortSignal): void {
  if (signal.aborted) throw new MsdCancelledError(image);
}

/** Backs off from 250 ms to 2 s. An abort rejects instead of waiting out the timer. */
function catalogDelay(ms: number, image: string, signal: AbortSignal): Promise<void> {
  throwIfCancelled(image, signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new MsdCancelledError(image));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One catalog row. Ready means that exact name is present, complete,
 * and the same size we wrote when the size is known. A missing row, or
 * a row whose size is still 0, is stale and keeps waiting. complete
 * false keeps waiting until the deadline even when the size is already
 * different: that size can still change. A complete row of the wrong
 * size is a stable mismatch and fails at once. The deadline turns a
 * stale row into PIKVM_MSD_CATALOG_TIMEOUT.
 */
function catalogVerdict(
  row: MsdImageRecord | undefined,
  expected: number | undefined,
): 'ready' | 'wait' | 'incomplete' | 'size' {
  if (!row) return 'wait';
  const sizeKnown = expected !== undefined;
  const sizeOk = !sizeKnown || row.size === expected;
  if (row.complete === true && sizeOk) return 'ready';
  // complete false keeps waiting until the deadline even when the size
  // already differs. That size can still change, so it is not a mismatch.
  if (row.complete !== true) {
    if (row.size > 0) return 'incomplete';
    return 'wait';
  }
  if (sizeKnown && row.size > 0 && row.size !== expected) return 'size';
  if (!sizeOk) return 'size';
  return 'wait';
}

function catalogFailure(image: string, row: MsdImageRecord | undefined, expected: number | undefined): Error {
  const verdict = catalogVerdict(row, expected);
  if (verdict === 'incomplete') return new MsdImageIncompleteError(image);
  if (verdict === 'size' && row && expected !== undefined) {
    return new MsdSizeMismatchError(image, row.size, expected);
  }
  return new MsdCatalogTimeoutError(image);
}

const CATALOG_SEEN = 'catalogSeen';

function withCatalogSeen(err: unknown, seen: boolean): Error {
  const error = err instanceof Error ? err : new Error('catalog wait failed');
  if (Object.prototype.hasOwnProperty.call(error, CATALOG_SEEN)) return error;
  Object.defineProperty(error, CATALOG_SEEN, { value: seen, enumerable: false });
  return error;
}

function catalogSeen(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { catalogSeen?: boolean }).catalogSeen === true;
}

/**
 * Milliseconds from a monotonic clock. Catalog and removal-confirm
 * budgets use this so a step of the realtime clock does not shorten
 * or extend them. Job finishedAt stays on Date.now().
 */
function elapsedNow(): number {
  return performance.now();
}

/**
 * One GET /api/msd that cannot outlive `deadlineAt` or `cancel`.
 * `deadlineAt` is elapsedNow() plus the remaining budget.
 * The request time counts against the deadline: a slow read is aborted
 * instead of being allowed to finish after the budget.
 */
export async function readMsdState(
  client: PiKVMClient,
  deadlineAt: number,
  cancel?: AbortSignal,
): Promise<MsdState | 'deadline' | 'cancelled'> {
  if (cancel?.aborted) return 'cancelled';
  const left = deadlineAt - elapsedNow();
  // AbortSignal.timeout rejects a fractional delay, and a remainder
  // under 1 ms cannot be expressed. Ceil of that remainder would start
  // a GET the budget does not cover. Ceil above 1 ms keeps the read
  // from ending before the budget; that overshoot is under 1 ms.
  if (left < 1) return 'deadline';
  const attempt = AbortSignal.timeout(Math.ceil(left));
  const signal = cancel ? AbortSignal.any([attempt, cancel]) : attempt;
  try {
    return await client.getMsdState(signal);
  } catch (err) {
    if (cancel?.aborted) return 'cancelled';
    if (attempt.aborted || elapsedNow() >= deadlineAt) return 'deadline';
    throw err;
  }
}

/**
 * GET /api/msd until the image is ready, or the budget ends.
 * Does not POST the upload or write_remote again. Holds no lock;
 * the caller holds the MSD mutex for the whole wait. The budget is
 * elapsed time from the start, including each catalog read. It is
 * monotonic, so a realtime step does not move it.
 */
async function waitForCatalog(
  client: PiKVMClient,
  image: string,
  expected: number | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadlineAt = elapsedNow() + timeoutMs;
  let delayMs = CATALOG_POLL_MIN_MS;
  let last: MsdImageRecord | undefined;
  let seen = false;
  try {
    for (;;) {
      if (signal.aborted) throw new MsdCancelledError(image);
      const read = await readMsdState(client, deadlineAt, signal);
      if (read === 'cancelled') throw new MsdCancelledError(image);
      if (read === 'deadline') throw catalogFailure(image, last, expected);
      if (elapsedNow() >= deadlineAt) {
        last = read.images[image];
        if (last) seen = true;
        const late = catalogVerdict(last, expected);
        if (late === 'ready') return;
        throw catalogFailure(image, last, expected);
      }
      last = read.images[image];
      if (last) seen = true;
      const verdict = catalogVerdict(last, expected);
      if (verdict === 'ready') return;
      if (verdict === 'size' && last !== undefined && last.complete === true && expected !== undefined) {
        throw new MsdSizeMismatchError(image, last.size, expected);
      }
      const remain = deadlineAt - elapsedNow();
      if (remain <= 0) throw catalogFailure(image, last, expected);
      await catalogDelay(Math.min(delayMs, remain), image, signal);
      delayMs = Math.min(CATALOG_POLL_MAX_MS, delayMs * 2);
    }
  } catch (err) {
    throw withCatalogSeen(err, seen);
  }
}

/**
 * Stop a job. The catalog wait returns PIKVM_MSD_CANCELLED.
 * A write that already returned is not sent again.
 */
export function cancelMsdJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.state === 'done' || job.state === 'failed') return false;
  if (job.abort.signal.aborted) return false;
  job.abort.abort();
  return true;
}

/**
 * Confirm one image we wrote is gone. An unknown-image error is not
 * proof: the name can appear after kvmd has already answered 200.
 * Absence for the whole budget counts as gone. A successful remove
 * counts only after a later read shows the name absent. If the name
 * appears during the budget, it is removed again. Anything else is
 * PIKVM_MSD_REMOVAL_UNCONFIRMED. The MSD mutex is held for the budget
 * so a mount cannot select the name while it is being confirmed.
 * `unseenMs` is the budget while the name has not been seen. Once it
 * appears, the budget becomes `timeoutMs` measured from the start.
 * Each catalog read stops at that deadline.
 */
export async function confirmImageAbsent(
  client: PiKVMClient,
  device: string,
  image: string,
  timeoutMs: number,
  unseenMs?: number,
): Promise<{ removed: boolean; removeError?: ErrorFields }> {
  return withMsdLock(device, () => confirmImageAbsentLocked(client, image, timeoutMs, unseenMs));
}

async function confirmImageAbsentLocked(
  client: PiKVMClient,
  image: string,
  timeoutMs: number,
  unseenMs?: number,
): Promise<{ removed: boolean; removeError?: ErrorFields }> {
  const started = elapsedNow();
  let delayMs = CATALOG_POLL_MIN_MS;
  let removedOnce = false;
  let seen = false;
  let lastAbsent = false;
  const signal = new AbortController().signal;
  const budgetMs = (): number => (seen || unseenMs === undefined ? timeoutMs : unseenMs);

  const applyRow = async (state: MsdState): Promise<'absent' | 'removed'> => {
    if (!state.images[image]) {
      lastAbsent = true;
      return 'absent';
    }
    lastAbsent = false;
    seen = true;
    try {
      await client.msdRemove(image);
      removedOnce = true;
      return 'removed';
    } catch (err) {
      if (err instanceof KvmdError && err.type === 'MsdUnknownImageError') {
        lastAbsent = true;
        return 'absent';
      }
      throw err;
    }
  };

  try {
    for (;;) {
      const deadlineAt = started + budgetMs();
      if (deadlineAt - elapsedNow() <= 0) break;
      const read = await readMsdState(client, deadlineAt);
      if (read === 'deadline' || read === 'cancelled') break;
      const step = await applyRow(read);
      if (step === 'absent' && removedOnce) return { removed: true };
      const remain = started + budgetMs() - elapsedNow();
      if (remain <= 0) break;
      await catalogDelay(Math.min(delayMs, remain), image, signal);
      delayMs = Math.min(CATALOG_POLL_MAX_MS, delayMs * 2);
    }
    if (lastAbsent) return { removed: true };
    if (removedOnce) {
      const follow = await readMsdState(client, elapsedNow() + CATALOG_POLL_MIN_MS);
      if (follow !== 'deadline' && follow !== 'cancelled' && !follow.images[image]) {
        return { removed: true };
      }
    }
    return { removed: false, removeError: errorFields(new MsdRemovalUnconfirmedError(image)) };
  } catch (err) {
    return { removed: false, removeError: errorFields(err) };
  }
}

async function removeUploadedImage(
  client: PiKVMClient,
  image: string,
  device: string,
  timeoutMs: number,
  unseenMs?: number,
): Promise<{ removed: boolean; removeError?: ErrorFields }> {
  return confirmImageAbsent(client, device, image, timeoutMs, unseenMs);
}

/** Full readiness budget after the image was seen. A short cap when it was not. */
function cleanupBudgets(err: unknown, readyMs: number): { timeoutMs: number; unseenMs?: number } {
  if (catalogSeen(err)) return { timeoutMs: readyMs };
  return { timeoutMs: readyMs, unseenMs: Math.min(readyMs, MSD_UNSEEN_CONFIRM_MS) };
}

function failJob(job: JobRecord, err: unknown): void {
  job.state = 'failed';
  job.finishedAt = Date.now();
  job.error = errorFields(err);
}

/**
 * Remove an image we already wrote. The caller holds the MSD mutex for
 * this device. confirmImageAbsent would take that mutex again and wait
 * on this same hold.
 */
async function cleanupStoredImageLocked(
  client: PiKVMClient,
  image: string,
  err: unknown,
  readyMs: number,
  job: JobRecord,
): Promise<void> {
  const budgets = cleanupBudgets(err, readyMs);
  const cleanup = await confirmImageAbsentLocked(
    client,
    image,
    budgets.timeoutMs,
    budgets.unseenMs,
  );
  job.removed = cleanup.removed;
  if (cleanup.removeError) job.removeError = cleanup.removeError;
}

async function runUpload(
  client: PiKVMClient,
  request: UploadRequest,
  fh: FileHandle,
  size: number,
  expected: string | undefined,
  job: JobRecord,
): Promise<void> {
  const { device, file } = request;
  const pollMs = request.uploadPollMs !== undefined
    && Number.isSafeInteger(request.uploadPollMs)
    && request.uploadPollMs > 0
    ? request.uploadPollMs
    : UPLOAD_POLL_MS;
  let stream: Readable | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let failure: unknown;
  let digest = '';
  const signal = { bad: '' };
  const sent = { n: 0 };
  let wrote = false;
  let slotFree = false;
  let published = false;
  let cleaned = false;
  const hashRead: HashRead = { pending: false, closeAfter: undefined };
  let hashCloseStarted = false;
  try {
    if (request.beforeHash) await request.beforeHash();
    const hashBudgetMs = msdJobTimeoutOf(client);
    const hashIdleMs = msdIdleTimeoutOf(client);
    const hashDeadline = startHashDeadline(hashBudgetMs);
    let prehash: string;
    try {
      prehash = await hashFd(
        fh,
        size,
        hashDeadline.signal,
        hashBudgetMs,
        hashRead,
        hashIdleMs,
        file,
      );
    } finally {
      hashDeadline.done();
    }
    if (expected !== undefined && prehash !== expected) throw new Error('sha256 mismatch');
    await assertUploadAllowed(client, file, size);
    job.state = 'running';
    const hash = createHash('sha256');
    stream = fh.createReadStream({
      start: 0,
      end: size - 1,
      autoClose: false,
    });
    const source = stream;
    const body = Readable.from((async function* () {
      if (request.beforeUploadStream) await request.beforeUploadStream();
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        sent.n += buf.length;
        job.bytes = sent.n;
        yield buf;
      }
    })());
    timer = setInterval(() => {
      client.getMsdState().then((state) => {
        const up = state.uploading;
        if (!up) return;
        if (up.name !== file) signal.bad = 'storage.uploading name does not match';
        else if (up.size > 0 && up.size !== size) signal.bad = 'storage.uploading size does not match';
        else if (up.written > sent.n) signal.bad = 'storage.uploading is ahead of bytes sent';
      }).catch(() => undefined);
    }, pollMs);
    timer.unref();
    const result = await client.msdWrite(file, body, size, { removeIncomplete: true });
    wrote = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    digest = hash.digest('hex');
    job.sha256 = digest;
    if (signal.bad) throw new Error(signal.bad);
    if (digest !== prehash) throw new Error('sha256 changed while uploading');
    if (result.written !== size) throw new Error('written does not match size');
    job.state = 'awaiting_catalog';
    const readyMs = readyBudget(request.readyTimeoutMs);
    await withMsdLock(device, async () => {
      try {
        await waitForCatalog(client, file, size, readyMs, job.abort.signal);
      } catch (err) {
        if (failure === undefined) failure = err;
        await cleanupHeld(err);
        return;
      }
      job.bytes = size;
      // The slot is free before done is visible, and done is visible
      // before this lock lets a queued mount run. A close failure after
      // the image is in the catalog removes it before that lock drops.
      await releaseSlot();
      if (failure !== undefined) {
        await cleanupHeld(failure);
        return;
      }
      publishSuccess();
    });
  } catch (err) {
    if (failure === undefined) failure = err;
    if (wrote && !published && !cleaned) {
      const readyMs = readyBudget(request.readyTimeoutMs);
      const budgets = cleanupBudgets(err, readyMs);
      const cleanup = await removeUploadedImage(
        client,
        file,
        device,
        budgets.timeoutMs,
        budgets.unseenMs,
      );
      cleaned = true;
      job.removed = cleanup.removed;
      if (cleanup.removeError) job.removeError = cleanup.removeError;
    }
  } finally {
    if (timer) clearInterval(timer);
    if (!slotFree) await releaseSlot();
    if (!published) {
      if (failure !== undefined) publishFailure();
      else publishSuccess();
    }
    pruneJobs(jobLimitOf(request.jobLimit), jobTtlOf(request.jobTtlMs));
  }

  function publishSuccess(): void {
    published = true;
    job.state = 'done';
    job.finishedAt = Date.now();
    logMsd('msd_upload', device, file, true, undefined, { bytes: size, sha256: digest });
  }

  function publishFailure(): void {
    published = true;
    failJob(job, failure);
    logMsd('msd_upload', device, file, false, job.error?.type ?? 'Error', {
      bytes: job.bytes,
      ...(job.sha256 ? { sha256: job.sha256 } : {}),
      ...(job.removed !== undefined ? { removed: job.removed } : {}),
    });
  }

  function logHashCloseFailure(err: unknown): void {
    const raw = err instanceof Error && err.message ? err.message : 'close failed';
    logMsd('msd_upload', device, file, false, redactUrl(raw), { close: true });
  }

  function beginHashClose(): void {
    if (hashCloseStarted) return;
    hashCloseStarted = true;
    let closing: Promise<void>;
    try {
      closing = Promise.resolve(closeUpload(stream, fh, request.closeFile));
    } catch (err) {
      logHashCloseFailure(err);
      return;
    }
    void closing.then(undefined, (err: unknown) => {
      logHashCloseFailure(err);
    });
  }

  async function releaseSlot(): Promise<void> {
    if (slotFree) return;
    if (failure instanceof MsdHashTimeoutError || failure instanceof MsdHashIdleTimeoutError) {
      // Close needs a threadpool thread, and the syscall itself can block.
      // Waiting here would keep the slot on a hung filesystem, or while
      // hung reads already fill the pool. The slot is free first. The job
      // ceiling and the per-read idle bound both use this path. A read
      // still in flight closes the fd from that read's callback; otherwise
      // close starts now and is still not awaited. beforeSlotRelease runs
      // only after a close that held the slot, so it does not run here.
      releaseUpload(device);
      slotFree = true;
      closeWhenHashReadIdle(hashRead, beginHashClose);
      return;
    }
    try {
      await closeUpload(stream, fh, request.closeFile);
      if (request.beforeSlotRelease) await request.beforeSlotRelease();
    } catch (err) {
      if (failure === undefined) failure = err;
    } finally {
      releaseUpload(device);
      slotFree = true;
    }
  }

  async function cleanupHeld(err: unknown): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    await cleanupStoredImageLocked(
      client,
      file,
      err,
      readyBudget(request.readyTimeoutMs),
      job,
    );
  }
}

/**
 * Confine the path, then return a jobId. Hashing and the kvmd pre-check
 * run in the job (state hashing, then running, then awaiting_catalog).
 * Hashing stops at PIKVM_MSD_JOB_TIMEOUT_MS. That timer is not the
 * upload POST ceiling: the POST starts its own when hashing has finished.
 * On that hash timeout the upload slot is released without waiting for
 * the file close. The descriptor is closed from the in-flight read's
 * callback, or immediately when no read is in flight.
 * Each hash read also stops if it returns no bytes for
 * PIKVM_MSD_IDLE_TIMEOUT_MS. That bound resets when a read returns
 * bytes and does not cap total hash time. On that idle timeout the
 * slot is released the same way and the upload POST is not sent.
 * A sha256 mismatch fails the job and does not POST. A second upload
 * while one is running throws before it opens a file.
 */
export async function startMsdUpload(
  client: PiKVMClient,
  request: UploadRequest,
): Promise<{ jobId: string }> {
  const { device, file, confirmImage, sha256, maxBytes, extensions } = request;
  if (confirmImage !== file) throw new Error('confirmImage does not match image');
  assertBareName(file, extensions);
  const expected = sha256 === undefined ? undefined : normalizeSha256(sha256);
  acquireUpload(device);
  let opened: { fh: FileHandle; size: number };
  try {
    opened = await confine(request.localDir, file, maxBytes);
  } catch (err) {
    releaseUpload(device);
    throw err;
  }
  const job: JobRecord = {
    state: 'hashing',
    bytes: 0,
    total: opened.size,
    device,
    image: file,
    abort: new AbortController(),
  };
  const jobId = randomBytes(16).toString('hex');
  jobs.set(jobId, job);
  pruneJobs(jobLimitOf(request.jobLimit), jobTtlOf(request.jobTtlMs));
  void runUpload(client, request, opened.fh, opened.size, expected, job);
  return { jobId };
}

export async function removeMsd(
  client: PiKVMClient,
  image: string,
  confirmImage: string,
  device: string,
): Promise<RemoveResult> {
  if (confirmImage !== image) throw new Error('confirmImage does not match image');
  if (
    image.length === 0
    || image.includes('/')
    || image.includes('\\')
    || image.includes('\0')
    || image.includes('://')
  ) {
    throw new Error('image must be a storage name');
  }
  return withMsdLock(device, async () => {
    const state = await client.getMsdState();
    if (state.drive?.connected === true) {
      throw new MsdPreflightError('MsdConnectedError', 'drive is connected');
    }
    if (state.busy) throw new MsdPreflightError('MsdBusyError', 'kvmd MSD is busy');
    try {
      await client.msdRemove(image);
      const drive = (await client.getMsdState()).drive;
      logMsd('msd_remove', device, image, true);
      return { removed: true, drive };
    } catch (err) {
      logMsd('msd_remove', device, image, false, errorFields(err).type);
      throw err;
    }
  });
}

export interface FetchRequest {
  device: string;
  url: string;
  image?: string;
  confirmImage: string;
  extensions: readonly string[];
  allow: UrlAllowlist;
  allowPrivate: boolean;
  /** kvmd downloader connect timeout in seconds. Not the job wall clock. */
  connectTimeoutSec: number;
  resolveUrl?: (hostname: string) => Promise<string[]>;
  /** Awaited in the job before DNS. Unset in production. */
  beforeFetch?: () => Promise<void>;
  jobLimit?: number;
  jobTtlMs?: number;
  /** Catalog budget after a successful write_remote. Unset uses 30s. */
  readyTimeoutMs?: number;
}

async function assertFetchAllowed(client: PiKVMClient, image: string): Promise<void> {
  const state = await client.getMsdState();
  if (!state.online) throw new MsdPreflightError('MsdOfflineError', 'kvmd MSD is offline');
  if (state.busy) throw new MsdPreflightError('MsdBusyError', 'kvmd MSD is busy');
  if (state.drive?.connected === true) throw new MsdPreflightError('MsdConnectedError', 'drive is connected');
  if (state.images[image]) throw new MsdPreflightError('MsdImageExistsError', 'image already exists');
}

function isStateUnknown(err: unknown): boolean {
  return err instanceof KvmdError && err.type === 'PIKVM_MSD_STATE_UNKNOWN';
}

async function runFetch(
  client: PiKVMClient,
  request: FetchRequest,
  inspected: { href: string; hostname: string },
  image: string,
  job: JobRecord,
): Promise<void> {
  const { device } = request;
  let sawOurImage = false;
  let failure: unknown;
  let last: MsdWriteResult | undefined;
  let slotFree = false;
  let published = false;
  let cleaned = false;
  try {
    if (request.beforeFetch) await request.beforeFetch();
    const addresses = await resolveFetchHost(inspected.hostname, request.resolveUrl);
    assertResolvedAddresses(addresses, request.allow, request.allowPrivate);
    await assertFetchAllowed(client, image);
    for await (const row of client.msdWriteRemote(inspected.href, {
      image,
      removeIncomplete: true,
      timeout: request.connectTimeoutSec,
    })) {
      last = row;
      if (row.name === image) sawOurImage = true;
      job.bytes = row.written;
      job.total = row.size;
    }
    // msdWriteRemote throws PIKVM_MSD_STATE_UNKNOWN when the stream ends
    // with written !== size. That happens before this line, and the catch
    // below does not remove the image for that error.
    if (!last || !sawOurImage) {
      throw new Error('write_remote ended without progress for this image');
    }
    const expected = last.size > 0 ? last.size : undefined;
    job.bytes = last.written;
    job.total = last.size;
    job.state = 'awaiting_catalog';
    const readyMs = readyBudget(request.readyTimeoutMs);
    await withMsdLock(device, async () => {
      try {
        await waitForCatalog(client, image, expected, readyMs, job.abort.signal);
      } catch (err) {
        if (failure === undefined) failure = err;
        if (!isStateUnknown(err)) await cleanupFetchHeld(err);
        return;
      }
      releaseFetchSlot();
      publishFetchSuccess();
    });
  } catch (err) {
    if (failure === undefined) failure = err;
    if (sawOurImage && !published && !cleaned && !isStateUnknown(err)) {
      const readyMs = readyBudget(request.readyTimeoutMs);
      const budgets = cleanupBudgets(err, readyMs);
      const cleanup = await removeUploadedImage(
        client,
        image,
        device,
        budgets.timeoutMs,
        budgets.unseenMs,
      );
      cleaned = true;
      job.removed = cleanup.removed;
      if (cleanup.removeError) job.removeError = cleanup.removeError;
    }
  } finally {
    if (!slotFree) releaseFetchSlot();
    if (!published) {
      if (failure !== undefined) publishFetchFailure();
      else publishFetchSuccess();
    }
    pruneJobs(jobLimitOf(request.jobLimit), jobTtlOf(request.jobTtlMs));
  }

  function releaseFetchSlot(): void {
    if (slotFree) return;
    releaseUpload(device);
    slotFree = true;
  }

  async function cleanupFetchHeld(err: unknown): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    await cleanupStoredImageLocked(
      client,
      image,
      err,
      readyBudget(request.readyTimeoutMs),
      job,
    );
  }

  function publishFetchSuccess(): void {
    published = true;
    job.state = 'done';
    job.finishedAt = Date.now();
    logMsd('msd_fetch', device, image, true, undefined, { bytes: last?.written ?? job.bytes });
  }

  function publishFetchFailure(): void {
    published = true;
    failJob(job, failure);
    logMsd('msd_fetch', device, image, false, job.error?.type ?? 'Error', {
      bytes: job.bytes,
      ...(job.removed !== undefined ? { removed: job.removed } : {}),
    });
  }
}

/**
 * Accept the URL and image name, then return a jobId. DNS, the address
 * policy, the kvmd pre-check, and write_remote run in the job. A second
 * transfer while one is running throws before any kvmd call.
 */
export async function startMsdFetch(
  client: PiKVMClient,
  request: FetchRequest,
): Promise<{ jobId: string }> {
  const inspected = inspectFetchUrl(request.url, request.allow);
  const image = request.image ?? inspected.imageFromPath;
  assertBareName(image, request.extensions);
  if (request.confirmImage !== image) throw new Error('confirmImage does not match image');
  acquireUpload(request.device);
  const job: JobRecord = {
    state: 'running',
    bytes: 0,
    total: 0,
    device: request.device,
    image,
    abort: new AbortController(),
  };
  const jobId = randomBytes(16).toString('hex');
  jobs.set(jobId, job);
  pruneJobs(jobLimitOf(request.jobLimit), jobTtlOf(request.jobTtlMs));
  void runFetch(client, request, inspected, image, job);
  return { jobId };
}
