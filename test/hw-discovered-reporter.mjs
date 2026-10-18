// Modified 2026-10 by PLN: hardware skip lists discovered files (GPL-3.0; see NOTICE).

/**
 * node --test TAP does not print the file names it discovered, and a
 * child file's stderr is copied onto TAP stdout as a comment. This
 * reporter lists each file, forwards stdout and stderr, and keeps the
 * same "# tests N" summary lines.
 */

export default async function* report(source) {
  const seen = new Set();
  for await (const event of source) {
    const file = event?.data?.file;
    if (typeof file === 'string' && !seen.has(file)) {
      seen.add(file);
      yield `hw-discovered ${file}\n`;
    }
    if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      const message = String(event.data?.message ?? '');
      if (message) yield message.endsWith('\n') ? message : `${message}\n`;
    } else if (event.type === 'test:pass' && event.data?.skip) {
      yield `# SKIP ${event.data.skip}\n`;
    } else if (event.type === 'test:diagnostic' && event.data?.message) {
      yield `# ${event.data.message}\n`;
    }
  }
}
