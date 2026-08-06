'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  blameArguments,
  displayAuthor,
  formatBlameLabel,
  formatRelativeTime,
  isCommittedHash,
  lineAnchor,
  parseBlamePorcelain,
  showArguments,
  utf8ByteLength,
} = require('../build-test/src/core.js');

const HASH = '0123456789abcdef0123456789abcdef01234567';

function incrementalBlame({
  hash = HASH,
  author = 'Ada Lovelace',
  email = 'ada@example.com',
  time = 1_700_000_000,
  summary = 'Make the machine sing',
} = {}) {
  return [
    `${hash} 1 4 1`,
    `author ${author}`,
    `author-mail <${email}>`,
    `author-time ${time}`,
    'author-tz +0000',
    `summary ${summary}`,
    'filename src/example.ts',
    '',
  ].join('\n');
}

test('parses one-line incremental metadata and variable-length hashes', () => {
  const sha256 = 'a'.repeat(64);
  assert.deepEqual(parseBlamePorcelain(incrementalBlame({ hash: sha256 })), {
    commit: sha256,
    author: 'Ada Lovelace',
    email: 'ada@example.com',
    authorTime: 1_700_000_000,
    summary: 'Make the machine sing',
  });
});

test('uses email only when the author name is absent', () => {
  const info = parseBlamePorcelain(
    incrementalBlame({ author: '   ', email: 'fallback@example.com' }),
  );
  assert.ok(info);
  assert.equal(displayAuthor(info), 'fallback@example.com');

  const named = parseBlamePorcelain(
    incrementalBlame({ author: 'Grace Hopper', email: 'fallback@example.com' }),
  );
  assert.ok(named);
  assert.equal(displayAuthor(named), 'Grace Hopper');
});

test('rejects malformed porcelain and identifies uncommitted hashes', () => {
  assert.equal(parseBlamePorcelain('not porcelain'), null);
  assert.equal(
    parseBlamePorcelain(
      incrementalBlame().replace('author-time 1700000000', 'author-time nope'),
    ),
    null,
  );
  assert.equal(isCommittedHash('0'.repeat(40)), false);
  assert.equal(isCommittedHash(HASH), true);
});

test('formats stable relative times across useful units', () => {
  const now = 2_000_000_000_000;
  const nowSeconds = now / 1000;
  assert.equal(formatRelativeTime(nowSeconds - 20, now), 'just now');
  assert.equal(formatRelativeTime(nowSeconds - 120, now), '2 minutes ago');
  assert.equal(formatRelativeTime(nowSeconds - 3 * 3600, now), '3 hours ago');
  assert.equal(formatRelativeTime(nowSeconds - 2 * 86400, now), '2 days ago');
  assert.equal(formatRelativeTime(nowSeconds - 14 * 86400, now), '2 weeks ago');
  assert.equal(formatRelativeTime(nowSeconds - 60 * 86400, now), '2 months ago');
  assert.equal(formatRelativeTime(nowSeconds - 730 * 86400, now), '2 years ago');
  assert.equal(formatRelativeTime(nowSeconds + 120, now), 'in 2 minutes');
});

test('builds the requested author, time, and icon label', () => {
  const info = parseBlamePorcelain(
    incrementalBlame({ time: 1_999_999_880 }),
  );
  assert.ok(info);
  assert.equal(
    formatBlameLabel(info, 2_000_000_000_000),
    ' Ada Lovelace • 2 minutes ago  ↗',
  );
});

test('derives efficient EOL anchors for LF, CRLF, and Unicode EOF lines', () => {
  assert.deepEqual(
    lineAnchor({
      lineNumber: 0,
      byteStart: 10,
      byteEnd: 16,
      content: 'hello\n',
    }),
    { anchor: 15, before: true, lineByteLength: 5 },
  );
  assert.deepEqual(
    lineAnchor({
      lineNumber: 1,
      byteStart: 16,
      byteEnd: 19,
      content: 'x\r\n',
    }),
    { anchor: 17, before: true, lineByteLength: 1 },
  );
  assert.deepEqual(
    lineAnchor({
      lineNumber: 2,
      byteStart: 19,
      byteEnd: 24,
      content: 'a🙂',
    }),
    { anchor: 20, before: false, lineByteLength: 5 },
  );
  assert.equal(
    lineAnchor({ lineNumber: 0, byteStart: 0, byteEnd: 0, content: '' }),
    null,
  );
  assert.equal(utf8ByteLength('a🙂'), 5);
});

test('constructs shell-safe argv for blame and commit diff', () => {
  assert.deepEqual(blameArguments(6, '- odd name.ts'), [
    '--no-pager',
    'blame',
    '--incremental',
    '-L',
    '7,7',
    '--',
    '- odd name.ts',
  ]);
  assert.deepEqual(showArguments(HASH), [
    '--no-pager',
    'show',
    '--stat',
    '--patch',
    '--no-ext-diff',
    '--no-color',
    HASH,
  ]);
});
