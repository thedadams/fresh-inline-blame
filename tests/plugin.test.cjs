'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const PLUGIN = path.resolve(
  __dirname,
  '../.test-dist/plugin/fresh-inline-blame.js',
);
const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER_HASH = 'fedcba9876543210fedcba9876543210fedcba98';
const VIRTUAL_TEXT_ID = 'fresh-inline-blame:current';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

function incrementalBlame({
  hash = HASH,
  author = 'Ada Lovelace',
  email = 'ada@example.com',
  time = Math.floor(Date.now() / 1000) - 120,
  summary = 'Make the machine sing',
} = {}) {
  return [
    `${hash} 1 1 1`,
    `author ${author}`,
    `author-mail <${email}>`,
    `author-time ${time}`,
    'author-tz +0000',
    `summary ${summary}`,
    'filename example.ts',
    '',
  ].join('\n');
}

function successfulBlame(options) {
  return {
    stdout: incrementalBlame(options),
    stderr: '',
    exit_code: 0,
  };
}

function localPathValue(target) {
  return typeof target === 'string' ? target : target.value;
}

function stringCellWidth(text) {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint === 0 ||
      codePoint === 0x200d ||
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint < 0xa0) ||
      /\p{Mark}/u.test(character)
    ) {
      continue;
    }

    const isWide =
      codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd));
    width += isWide ? 2 : 1;
  }
  return width;
}

function sourceCellWidth(text, tabSize) {
  let width = 0;
  const segments = text.split('\t');
  for (let index = 0; index < segments.length; index += 1) {
    width += stringCellWidth(segments[index]);
    if (index + 1 < segments.length) {
      width += tabSize - (width % tabSize);
    }
  }
  return width;
}

function createHarness(options = {}) {
  const handlers = new Map();
  const files = new Set(options.files ?? []);
  const viewport = {
    topByte: 0,
    topLine: 0,
    leftColumn: 0,
    width: 100,
    height: 24,
    ...options.viewport,
  };
  const pluginConfig = {
    debounceMs: 0,
    ...options.config,
  };
  const state = {
    activeBufferId: options.activeBufferId ?? 1,
    activeSplitId: options.activeSplitId ?? 1,
    trust: options.trust ?? 'trusted',
    cursor: {
      position: 0,
      selection: null,
      line: options.line ?? 0,
    },
    buffer: {
      id: 1,
      path: '/work/project/example.ts',
      modified: false,
      length: 128,
      line_count: 8,
      is_virtual: false,
      is_terminal: false,
      editing_disabled: false,
      view_mode: 'source',
      is_composing_in_any_split: false,
      compose_width: null,
      language: 'typescript',
      is_preview: false,
      splits: [1],
      ...options.buffer,
    },
    viewport,
    configDefinitions: [],
    configReads: 0,
    freshConfig: options.freshConfig ?? {
      editor: {
        line_numbers: true,
        wrap_column: null,
        tab_size: 4,
      },
      languages: {},
    },
    events: [],
    commands: [],
    refreshLines: [],
    virtualTextAdds: [],
    virtualTextRemoves: [],
    processes: [],
    delays: [],
    createdDirectories: [],
    fileExistsChecks: [],
    writes: [],
    openedFiles: [],
    refreshedBuffers: [],
    readOnlyFiles: [],
    indentationGuides: [],
    splits: [
      {
        splitId: 1,
        bufferId: 1,
        x: 4,
        y: 2,
        width: 100,
        height: 24,
        viewport,
        ...options.split,
      },
    ],
    splitWindows: [],
    splitBuffers: [],
    closedOtherBuffers: [],
    focusedSplits: [],
    statuses: [],
    debug: [],
  };

  function defineConfig(kind, name, definition) {
    state.configDefinitions.push({ kind, name, definition });
    return pluginConfig[name] ?? definition.default;
  }

  function spawnProcess(command, args, cwd, stdoutTo) {
    const pending = deferred();
    const processState = {
      command,
      args: [...args],
      cwd,
      stdoutTo,
      killed: 0,
      resolve: pending.resolve,
      reject: pending.reject,
    };
    const handle = {
      result: pending.promise,
      then: (onFulfilled, onRejected) =>
        pending.promise.then(onFulfilled, onRejected),
    };
    if (!options.omitProcessKill) {
      handle.kill = () => {
        processState.killed += 1;
        // Fresh 0.4.6's spawnProcess wrapper returns a synchronous boolean,
        // even though its generated declaration says Promise<boolean>.
        return true;
      };
    }
    processState.handle = handle;
    state.processes.push(processState);
    return handle;
  }

  const editor = {
    defineConfigBoolean: (name, definition) =>
      defineConfig('boolean', name, definition),
    defineConfigInteger: (name, definition) =>
      defineConfig('integer', name, definition),
    getPluginConfig: () => {
      state.configReads += 1;
      return pluginConfig;
    },
    getConfig: () => state.freshConfig,

    getActiveBufferId: () => state.activeBufferId,
    getActiveSplitId: () => state.activeSplitId,
    getBufferInfo: (bufferId) =>
      bufferId === state.buffer.id ? { ...state.buffer } : null,
    getBufferPath: (bufferId) =>
      bufferId === state.buffer.id ? state.buffer.path : '',
    getPrimaryCursor: () => ({ ...state.cursor }),
    getViewport: () => ({ ...state.viewport }),
    stringWidth: (value) => stringCellWidth(value),
    pathDirname: (value) => path.posix.dirname(value),
    pathBasename: (value) => path.posix.basename(value),
    workspaceTrustLevel: () => state.trust,

    addVirtualTextStyled: (
      bufferId,
      virtualTextId,
      position,
      text,
      style,
      before,
    ) => {
      state.virtualTextAdds.push({
        bufferId,
        virtualTextId,
        position,
        text,
        style,
        before,
      });
      return true;
    },
    removeVirtualText: (bufferId, virtualTextId) => {
      state.virtualTextRemoves.push({ bufferId, virtualTextId });
      return true;
    },
    refreshLines: (bufferId) => {
      state.refreshLines.push(bufferId);
      return true;
    },

    spawnProcess,
    delay: (durationMs) => {
      const pending = deferred();
      state.delays.push({ durationMs, ...pending });
      return pending.promise;
    },

    getDataDir: () => '/data',
    localPath: (value) => ({ kind: 'local', value }),
    createDir: (target) => {
      state.createdDirectories.push(localPathValue(target));
      return options.createDirResult ?? true;
    },
    fileExists: (target) => {
      const value = localPathValue(target);
      state.fileExistsChecks.push(value);
      return files.has(value);
    },
    writeFile: (target, content) => {
      const value = localPathValue(target);
      state.writes.push({ path: value, content });
      files.add(value);
      return true;
    },
    openFileStreaming: async (value) => {
      state.openedFiles.push(value);
      return Object.hasOwn(options, 'openFileResult')
        ? options.openFileResult
        : 91;
    },
    refreshBufferFromDisk: async (bufferId) => {
      state.refreshedBuffers.push(bufferId);
      return bufferId;
    },
    markFileReadOnly: (value) => {
      state.readOnlyFiles.push(value);
      return true;
    },
    setIndentationGuide: (bufferId, enabled) => {
      state.indentationGuides.push({ bufferId, enabled });
      return true;
    },

    listSplits: () => state.splits.map((split) => ({ ...split })),
    splitWindow: async (splitOptions) => {
      state.splitWindows.push({ ...splitOptions });
      const created = {
        splitId: 10 + state.splitWindows.length,
        sourceSplitId: 1,
        bufferId: splitOptions.file
          ? 90 + state.splitWindows.length
          : state.activeBufferId,
        x: 0,
        y: 0,
        width: 100,
        height: 20,
      };
      state.splits.push({ ...created, viewport: { ...state.viewport } });
      return created;
    },
    closeOtherBuffersInSplit: (bufferId, splitId) => {
      state.closedOtherBuffers.push({ bufferId, splitId });
      return true;
    },
    setSplitBuffer: (splitId, bufferId) => {
      state.splitBuffers.push({ splitId, bufferId });
      const existing = state.splits.find((split) => split.splitId === splitId);
      if (existing === undefined) state.splits.push({ splitId, bufferId });
      else existing.bufferId = bufferId;
      return true;
    },
    focusSplit: (splitId) => {
      state.focusedSplits.push(splitId);
      return true;
    },

    on: (eventName, handlerName) => {
      state.events.push({ eventName, handlerName });
    },
    off: () => {},
    registerCommand: (name, description, handlerName) => {
      state.commands.push({ name, description, handlerName });
    },
    setStatus: (message) => state.statuses.push(message),
    debug: (message) => state.debug.push(message),
  };

  const previousGetEditor = global.getEditor;
  const previousRegisterHandler = global.registerHandler;
  global.getEditor = () => editor;
  global.registerHandler = (name, handler) => handlers.set(name, handler);
  try {
    delete require.cache[require.resolve(PLUGIN)];
    require(PLUGIN);
  } finally {
    if (previousGetEditor === undefined) delete global.getEditor;
    else global.getEditor = previousGetEditor;
    if (previousRegisterHandler === undefined) delete global.registerHandler;
    else global.registerHandler = previousRegisterHandler;
  }

  function fire(handlerName, payload = {}) {
    const handler = handlers.get(handlerName);
    assert.equal(typeof handler, 'function', `missing handler ${handlerName}`);
    return handler(payload);
  }

  function cacheLine(line, content, byteStart = line * 100) {
    const byteLength = Buffer.byteLength(content, 'utf8');
    fire('inlineBlameOnLinesChanged', {
      buffer_id: state.buffer.id,
      epoch: 1,
      lines: [
        {
          line_number: line,
          byte_start: byteStart,
          byte_end: byteStart + byteLength,
          content,
        },
      ],
    });
  }

  function moveCursor(line) {
    state.cursor.line = line;
    state.cursor.position = line * 100;
    fire('inlineBlameOnCursorMoved', {
      buffer_id: state.buffer.id,
      cursor_id: 0,
      line: line + 1,
    });
  }

  return {
    editor,
    handlers,
    state,
    fire,
    cacheLine,
    moveCursor,
    resolveProcess(index, result = successfulBlame()) {
      const spawned = state.processes[index];
      assert.ok(spawned, `missing process ${index}`);
      spawned.resolve(result);
    },
    rejectProcess(index, error) {
      const spawned = state.processes[index];
      assert.ok(spawned, `missing process ${index}`);
      spawned.reject(error);
    },
    resolveDelay(index) {
      const delayed = state.delays[index];
      assert.ok(delayed, `missing delay ${index}`);
      delayed.resolve();
    },
  };
}

async function renderInitialBlame(harness, options = {}) {
  const content = options.content ?? 'const answer = 42;\n';
  harness.cacheLine(0, content, 0);
  harness.resolveProcess(0, successfulBlame(options.blame));
  await waitFor(
    () => harness.state.virtualTextAdds.length === 1,
    'initial blame did not render',
  );
  return content;
}

test('initializes Fresh hooks and renders blame only at the active line end', async () => {
  const harness = createHarness();

  assert.deepEqual(
    harness.state.configDefinitions.map(({ kind, name }) => ({ kind, name })),
    [
      { kind: 'boolean', name: 'enabled' },
      { kind: 'integer', name: 'debounceMs' },
      { kind: 'boolean', name: 'debug' },
    ],
  );
  assert.deepEqual(
    harness.state.events.map(({ eventName }) => eventName),
    [
      'cursor_moved',
      'buffer_activated',
      'buffer_deactivated',
      'buffer_closed',
      'after_insert',
      'after_delete',
      'after_file_save',
      'lines_changed',
      'mouse_click',
      'focus_gained',
      'trust_changed',
      'config_changed',
    ],
  );
  assert.deepEqual(
    harness.state.commands.map(({ name }) => name),
    ['Inline Blame: Refresh', 'Inline Blame: Open Commit Diff'],
  );
  assert.deepEqual(harness.state.refreshLines, [1]);
  assert.deepEqual(
    harness.state.processes.map(({ command, args, cwd, stdoutTo }) => ({
      command,
      args,
      cwd,
      stdoutTo,
    })),
    [
      {
        command: 'git',
        args: [
          '--no-pager',
          'blame',
          '--incremental',
          '-L',
          '1,1',
          '--',
          'example.ts',
        ],
        cwd: '/work/project',
        stdoutTo: undefined,
      },
    ],
  );

  const content = await renderInitialBlame(harness);
  const rendered = harness.state.virtualTextAdds[0];
  assert.equal(rendered.bufferId, 1);
  assert.equal(rendered.virtualTextId, VIRTUAL_TEXT_ID);
  assert.equal(rendered.position, Buffer.byteLength(content, 'utf8') - 1);
  assert.match(rendered.text, /^ Ada Lovelace • 2 minutes ago  ↗$/);
  assert.deepEqual(rendered.style, { fg: 'editor.line_number_fg' });
  assert.equal(rendered.before, true);
  assert.equal(harness.state.virtualTextAdds.length, 1);
});

test('same-line cursor movement performs no editor or Git work', async () => {
  const harness = createHarness();
  await renderInitialBlame(harness);
  const before = {
    processes: harness.state.processes.length,
    refreshLines: harness.state.refreshLines.length,
    adds: harness.state.virtualTextAdds.length,
    removes: harness.state.virtualTextRemoves.length,
  };

  harness.moveCursor(0);
  harness.moveCursor(0);
  harness.moveCursor(0);
  await flush();

  assert.deepEqual(
    {
      processes: harness.state.processes.length,
      refreshLines: harness.state.refreshLines.length,
      adds: harness.state.virtualTextAdds.length,
      removes: harness.state.virtualTextRemoves.length,
    },
    before,
  );
});

test('tracks the primary cursor when a nonzero cursor id moves', async () => {
  const harness = createHarness();
  await renderInitialBlame(harness);
  harness.cacheLine(2, 'primary cursor line\n', 200);
  harness.state.cursor.line = 2;

  harness.fire('inlineBlameOnCursorMoved', {
    buffer_id: 1,
    cursor_id: 17,
    line: 99,
  });
  await waitFor(
    () => harness.state.processes.length === 2,
    'primary cursor movement did not request blame',
  );
  assert.deepEqual(harness.state.processes[1].args.slice(3, 6), [
    '-L',
    '3,3',
    '--',
  ]);
});

test('rapid line changes coalesce into one blame process for the final line', async () => {
  const harness = createHarness({ config: { debounceMs: 15 } });
  assert.equal(harness.state.processes.length, 0);
  assert.equal(harness.state.delays.length, 1);

  harness.moveCursor(1);
  harness.moveCursor(2);
  harness.moveCursor(3);
  const finalLine = 'return finalAnswer;\n';
  harness.cacheLine(3, finalLine, 300);
  assert.equal(harness.state.processes.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 25));
  harness.resolveDelay(0);
  await waitFor(
    () => harness.state.processes.length === 1,
    'coalesced blame process did not start',
  );

  assert.deepEqual(harness.state.processes[0].args, [
    '--no-pager',
    'blame',
    '--incremental',
    '-L',
    '4,4',
    '--',
    'example.ts',
  ]);
  harness.resolveProcess(0, successfulBlame({ author: 'Final Author' }));
  await waitFor(
    () => harness.state.virtualTextAdds.length === 1,
    'final coalesced blame did not render',
  );
  assert.match(harness.state.virtualTextAdds[0].text, /^ Final Author /);
  assert.equal(
    harness.state.virtualTextAdds[0].position,
    300 + Buffer.byteLength(finalLine, 'utf8') - 1,
  );
});

test('cancels an active blame and ignores its stale completion', async () => {
  const harness = createHarness();
  harness.cacheLine(0, 'old line\n', 0);
  assert.equal(harness.state.processes.length, 1);

  harness.moveCursor(1);
  harness.moveCursor(2);
  harness.cacheLine(2, 'current line\n', 200);
  assert.equal(harness.state.processes[0].killed, 1);
  assert.equal(harness.state.processes.length, 1);

  harness.resolveProcess(0, successfulBlame({ author: 'Stale Author' }));
  await waitFor(
    () => harness.state.processes.length === 2,
    'replacement blame process did not start',
  );
  assert.equal(harness.state.virtualTextAdds.length, 0);
  assert.deepEqual(harness.state.processes[1].args.slice(3, 6), [
    '-L',
    '3,3',
    '--',
  ]);

  harness.resolveProcess(
    1,
    successfulBlame({ hash: OTHER_HASH, author: 'Current Author' }),
  );
  await waitFor(
    () => harness.state.virtualTextAdds.length === 1,
    'current blame did not render',
  );
  assert.match(harness.state.virtualTextAdds[0].text, /^ Current Author /);
  assert.doesNotMatch(harness.state.virtualTextAdds[0].text, /Stale Author/);
  assert.equal(harness.state.virtualTextAdds[0].position, 212);
});

test('ignores stale blame when a runtime process handle cannot be killed', async () => {
  const harness = createHarness({ omitProcessKill: true });
  harness.cacheLine(0, 'old line\n', 0);
  harness.cacheLine(1, 'current line\n', 100);

  assert.doesNotThrow(() => harness.moveCursor(1));
  assert.equal(harness.state.processes[0].killed, 0);

  harness.resolveProcess(0, successfulBlame({ author: 'Stale Author' }));
  await waitFor(
    () => harness.state.processes.length === 2,
    'replacement blame process did not start',
  );
  assert.equal(harness.state.virtualTextAdds.length, 0);

  harness.resolveProcess(
    1,
    successfulBlame({ hash: OTHER_HASH, author: 'Current Author' }),
  );
  await waitFor(
    () => harness.state.virtualTextAdds.length === 1,
    'current blame did not render',
  );
  assert.match(harness.state.virtualTextAdds[0].text, /^ Current Author /);
});

test('renders when the requested line snapshot arrives after the grace period', async () => {
  const harness = createHarness();
  harness.resolveProcess(0, successfulBlame({ author: 'Late Snapshot' }));
  await waitFor(
    () => harness.state.delays.some(({ durationMs }) => durationMs === 16),
    'line snapshot grace delay was not scheduled',
  );

  const grace = harness.state.delays.find(({ durationMs }) => durationMs === 16);
  grace.resolve();
  await flush();
  assert.equal(harness.state.virtualTextAdds.length, 0);

  harness.cacheLine(0, 'eventually rendered\n', 0);
  await waitFor(
    () => harness.state.virtualTextAdds.length === 1,
    'late line snapshot did not trigger a render retry',
  );
  assert.equal(harness.state.processes.length, 1, 'cached blame should be reused');
  assert.match(harness.state.virtualTextAdds[0].text, /^ Late Snapshot /);
});

test('modified buffers suppress blame and edits clear an existing render', async () => {
  const harness = createHarness({ buffer: { modified: true } });
  assert.equal(harness.state.processes.length, 0);
  assert.equal(harness.state.virtualTextAdds.length, 0);

  harness.state.buffer.modified = false;
  harness.fire('inlineBlameOnBufferActivated');
  await waitFor(
    () => harness.state.processes.length === 1,
    'clean buffer did not request blame',
  );
  await renderInitialBlame(harness);

  harness.state.buffer.modified = true;
  harness.fire('inlineBlameOnAfterInsert', { buffer_id: 1 });
  assert.deepEqual(harness.state.virtualTextRemoves, [
    { bufferId: 1, virtualTextId: VIRTUAL_TEXT_ID },
  ]);

  harness.moveCursor(1);
  await flush();
  assert.equal(harness.state.processes.length, 1);
  assert.equal(harness.state.virtualTextAdds.length, 1);
});

test('briefly caches path-level blame failures to avoid repeated Git work', async () => {
  const harness = createHarness();
  harness.resolveProcess(0, {
    stdout: '',
    stderr: 'fatal: not a git repository',
    exit_code: 128,
  });
  await flush();

  harness.cacheLine(1, 'another line\n', 100);
  harness.moveCursor(1);
  await flush();
  await flush();
  assert.equal(harness.state.processes.length, 1);
  assert.equal(harness.state.virtualTextAdds.length, 0);
});

test('clicking the blame icon streams and opens the commit diff', async () => {
  const harness = createHarness({ viewport: { leftColumn: 3 } });
  const content = await renderInitialBlame(harness);
  const rendered = harness.state.virtualTextAdds[0];
  const lineByteLength = Buffer.byteLength(content.slice(0, -1), 'utf8');
  const sourceWidth = stringCellWidth(content.slice(0, -1));
  const split = harness.state.splits[0];
  const lineNumberDigits = Math.max(
    2,
    String(harness.state.buffer.line_count).length,
  );
  const gutterWidth = 1 + lineNumberDigits + 3;
  const annotationStartColumn =
    split.x +
    gutterWidth +
    sourceWidth +
    1 -
    harness.state.viewport.leftColumn;
  const arrowTextIndex = rendered.text.lastIndexOf('↗');
  assert.notEqual(arrowTextIndex, -1, 'rendered blame is missing its arrow');
  const arrowColumn =
    annotationStartColumn +
    stringCellWidth(rendered.text.slice(0, arrowTextIndex));
  const relativeTimeIndex = rendered.text.indexOf('2 minutes ago');
  assert.notEqual(
    relativeTimeIndex,
    -1,
    'rendered blame is missing its relative time',
  );
  const click = {
    column: arrowColumn,
    row: split.y,
    modifiers: '',
    content_x: split.x,
    content_y: split.y,
    buffer_id: 1,
    buffer_row: 0,
    buffer_col: lineByteLength,
    button: 'left',
  };

  const ignoredClicks = [
    {
      name: 'author text',
      column: annotationStartColumn + 2,
    },
    {
      name: 'relative time text',
      column:
        annotationStartColumn +
        stringCellWidth(rendered.text.slice(0, relativeTimeIndex + 2)),
    },
    {
      name: 'padding immediately before the arrow',
      column: arrowColumn - 1,
    },
    {
      name: 'cell immediately after the arrow',
      column: arrowColumn + 1,
    },
    {
      name: 'several cells after the arrow',
      column: arrowColumn + 8,
    },
    {
      name: 'wrong mouse button over the arrow',
      column: arrowColumn,
      button: 'right',
    },
  ];

  for (const ignored of ignoredClicks) {
    const payload = { ...click, ...ignored };
    delete payload.name;
    assert.equal(
      payload.buffer_col,
      lineByteLength,
      `${ignored.name} must model Fresh's EOL-clamped buffer column`,
    );
    harness.fire('inlineBlameOnMouseClick', payload);
    await flush();
    assert.equal(
      harness.state.processes.length,
      1,
      `${ignored.name} unexpectedly opened the commit diff`,
    );
  }

  harness.state.activeSplitId = 2;
  harness.fire('inlineBlameOnMouseClick', click);
  await flush();
  assert.equal(
    harness.state.processes.length,
    1,
    'an annotation in an inactive split opened the commit diff',
  );
  harness.state.activeSplitId = 1;

  harness.fire('inlineBlameOnMouseClick', {
    ...click,
    buffer_col: lineByteLength - 1,
  });
  await flush();
  assert.equal(
    harness.state.processes.length,
    1,
    'a source-text click with the arrow screen column opened the diff',
  );

  harness.fire('inlineBlameOnMouseClick', {
    ...click,
  });
  await waitFor(
    () => harness.state.closedOtherBuffers.length === 1,
    'commit diff was not opened in a split',
  );

  const diffPath = `/data/fresh-inline-blame/visible-v1/${HASH}.diff`;
  assert.equal(harness.state.processes.length, 2);
  assert.deepEqual(
    {
      command: harness.state.processes[1].command,
      args: harness.state.processes[1].args,
      cwd: harness.state.processes[1].cwd,
      stdoutTo: harness.state.processes[1].stdoutTo,
    },
    {
      command: 'git',
      args: [
        '--no-pager',
        'show',
        '--stat',
        '--patch',
        '--no-ext-diff',
        '--no-color',
        HASH,
      ],
      cwd: '/work/project',
      stdoutTo: diffPath,
    },
  );
  assert.deepEqual(harness.state.createdDirectories, [
    '/data/fresh-inline-blame/visible-v1',
  ]);
  assert.deepEqual(harness.state.openedFiles, []);
  assert.deepEqual(harness.state.readOnlyFiles, [diffPath]);
  assert.deepEqual(harness.state.indentationGuides, [
    { bufferId: 91, enabled: false },
  ]);
  assert.deepEqual(harness.state.splitWindows, [
    {
      direction: 'horizontal',
      place: 'after',
      ratio: 0.5,
      file: diffPath,
    },
  ]);
  assert.deepEqual(harness.state.splitBuffers, []);
  assert.deepEqual(harness.state.closedOtherBuffers, [
    { splitId: 11, bufferId: 91 },
  ]);
  assert.deepEqual(harness.state.focusedSplits, [11]);
  assert.match(
    harness.state.statuses.at(-1),
    /^Inline Blame: 0123456789ab by Ada Lovelace$/,
  );

  harness.state.activeBufferId = 91;
  harness.fire('inlineBlameOnBufferActivated');
  await flush();
  assert.equal(
    harness.state.processes.length,
    2,
    'the plugin must not blame its own generated diff buffer',
  );

  harness.resolveProcess(1, { stdout: '', stderr: '', exit_code: 0 });
  await flush();
  const pollDelay = harness.state.delays.find(
    ({ durationMs }) => durationMs === 100,
  );
  assert.ok(pollDelay, 'diff polling delay was not scheduled');
  pollDelay.resolve();
  await waitFor(
    () => harness.state.writes.length === 2,
    'completed diff was not marked done',
  );
  assert.deepEqual(harness.state.writes, [
    { path: diffPath, content: '' },
    { path: `${diffPath}.done`, content: '' },
  ]);
  assert.ok(harness.state.refreshedBuffers.includes(91));
});

test('closing the commit diff tab releases its view and running process', async () => {
  const harness = createHarness();
  await renderInitialBlame(harness);

  harness.fire('inlineBlameOpenCommit');
  await waitFor(
    () => harness.state.closedOtherBuffers.length === 1,
    'commit diff did not become the split\'s sole tab',
  );
  assert.equal(harness.state.processes.length, 2);
  assert.deepEqual(harness.state.closedOtherBuffers[0], {
    bufferId: 91,
    splitId: 11,
  });

  harness.state.splits = harness.state.splits.filter(
    ({ splitId }) => splitId !== 11,
  );
  harness.state.activeBufferId = 1;
  harness.state.activeSplitId = 1;
  harness.fire('inlineBlameOnBufferClosed', { buffer_id: 91 });
  await flush();
  assert.equal(
    harness.state.processes[1].killed,
    1,
    'closing the diff tab did not stop its in-flight git show',
  );

  harness.fire('inlineBlameOpenCommit');
  await waitFor(
    () => harness.state.closedOtherBuffers.length === 2,
    'closed diff view was incorrectly reused',
  );
  assert.equal(harness.state.processes.length, 3);
  assert.deepEqual(harness.state.closedOtherBuffers[1], {
    bufferId: 92,
    splitId: 12,
  });
});

test('tab-indented lines keep the blame icon clickable and isolated', async () => {
  const tabSize = 4;
  const harness = createHarness({
    buffer: { language: 'go' },
    freshConfig: {
      editor: {
        line_numbers: true,
        wrap_column: null,
        tab_size: 4,
      },
      languages: {},
    },
  });
  const content = await renderInitialBlame(harness, {
    content: '\t\tif err != nil {\n',
  });
  const rendered = harness.state.virtualTextAdds[0];
  const split = harness.state.splits[0];
  const source = content.slice(0, -1);
  const lineByteLength = Buffer.byteLength(source, 'utf8');
  const lineNumberDigits = Math.max(
    2,
    String(harness.state.buffer.line_count).length,
  );
  const gutterWidth = 1 + lineNumberDigits + 3;
  const arrowTextIndex = rendered.text.lastIndexOf('↗');
  const arrowColumn =
    split.x +
    gutterWidth +
    sourceCellWidth(source, tabSize) +
    1 +
    stringCellWidth(rendered.text.slice(0, arrowTextIndex));
  const click = {
    column: arrowColumn,
    row: split.y,
    modifiers: '',
    content_x: split.x,
    content_y: split.y,
    buffer_id: 1,
    buffer_row: 0,
    buffer_col: lineByteLength,
    button: 'left',
  };

  harness.fire('inlineBlameOnMouseClick', {
    ...click,
    column: arrowColumn + 4,
  });
  await flush();
  assert.equal(
    harness.state.processes.length,
    1,
    'a click after the tab-indented line blame opened the diff',
  );

  harness.fire('inlineBlameOnMouseClick', click);
  await waitFor(
    () => harness.state.processes.length === 2,
    'the blame icon on a tab-indented line did not open the diff',
  );
  assert.deepEqual(harness.state.processes[1].args, [
    '--no-pager',
    'show',
    '--stat',
    '--patch',
    '--no-ext-diff',
    '--no-color',
    HASH,
  ]);
});
