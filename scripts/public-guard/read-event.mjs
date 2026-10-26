// Modified 2026-10 by PLN: public-file privacy guard (GPL-3.0; see NOTICE).
// GPL-3.0-only. See LICENSE and NOTICE.
//
// Reads the workflow event from EVENT_JSON. Does not print the event.
//   node read-event.mjs head-repo
//   node read-event.mjs write <directory>

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

function loadEvent() {
  const raw = process.env.EVENT_JSON
  if (raw === undefined || raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    process.stderr.write('event: invalid json\n')
    process.exit(1)
  }
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
