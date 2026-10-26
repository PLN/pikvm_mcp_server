// Modified 2026-10 by PLN: public-file privacy guard (GPL-3.0; see NOTICE).
//
// Reads the workflow event. Does not print the event.
// The file is PUBLIC_GUARD_EVENT_PATH, or else GITHUB_EVENT_PATH.
// EVENT_JSON is a local override for tests. The workflow does not set it.
//   node read-event.mjs head-repo
//   node read-event.mjs write <directory>

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function parseEvent(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    process.stderr.write('event: invalid json\n')
    process.exit(1)
  }
}

function loadEvent() {
  const inline = process.env.EVENT_JSON
  if (inline !== undefined && inline !== '') return parseEvent(inline)
  const path = process.env.PUBLIC_GUARD_EVENT_PATH || process.env.GITHUB_EVENT_PATH || ''
  if (path === '') return {}
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    process.stderr.write('event: unreadable\n')
    process.exit(1)
  }
  if (raw.trim() === '') return {}
  return parseEvent(raw)
}

const event = loadEvent()
const mode = process.argv[2]

if (mode === 'head-repo') {
  const repo = event.pull_request && event.pull_request.head
    ? event.pull_request.head.repo
    : null
  const name = repo && typeof repo.full_name === 'string' ? repo.full_name : ''
  process.stdout.write(name)
  process.exit(0)
}

if (mode !== 'write') {
  process.stderr.write('event: usage\n')
  process.exit(1)
}

const dir = process.argv[3]
const pr = event.pull_request || {}
const fields = {
  event_name: process.env.EVENT_NAME || '',
  sha: process.env.GIT_SHA || '',
  before: typeof event.before === 'string' ? event.before : '',
  base: pr.base && typeof pr.base.sha === 'string' ? pr.base.sha : '',
  head: pr.head && typeof pr.head.sha === 'string' ? pr.head.sha : '',
  pr_title: typeof pr.title === 'string' ? pr.title : '',
  pr_body: typeof pr.body === 'string' ? pr.body : '',
  pr_author: pr.user && typeof pr.user.login === 'string' ? pr.user.login : '',
}

for (const [name, value] of Object.entries(fields)) {
  writeFileSync(join(dir, name), value)
}
