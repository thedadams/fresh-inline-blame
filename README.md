# Fresh Inline Blame

Fresh Inline Blame shows the Git author and relative commit time at the end of
the line containing the primary cursor:

```text
const answer = 42;    Ada Lovelace • 2 hours ago  ↗
```

The annotation moves with the cursor, and the previous line is cleared before
new blame information is requested. Click the `↗` icon (or run `Inline Blame:
Open Commit Diff`) to open that commit's patch in a read-only split inside
Fresh. The patch is the split's only tab, so closing its `×` also closes the
dedicated split.

## Requirements

- Fresh 0.5.2 or newer, with plugin API version 2
- `git` available on the editor host
- A trusted workspace and a saved, tracked file inside a Git worktree

Modified buffers, untracked lines, virtual buffers, terminals, pathless files,
and untrusted workspaces intentionally show no annotation.

## Install

Open Fresh's package manager, choose **Install from URL**, and enter this
repository's Git URL. For local development, enter the absolute path to this
checkout instead.

Fresh loads the entry point declared in `package.json`.

## Configuration

The plugin exposes these settings:

| Setting | Default | Description |
| --- | ---: | --- |
| `enabled` | `true` | Show blame for the current line. |
| `debounceMs` | `100` | Delay in milliseconds before starting Git blame (`0`–`1000`). |
| `debug` | `false` | Write timing and error diagnostics to the Fresh log. |

The command palette also provides:

- `Inline Blame: Refresh`
- `Inline Blame: Open Commit Diff`

## Performance

The plugin asks Git for exactly one line with incremental `git blame -L` output,
waits briefly for cursor movement to settle, and cancels obsolete processes.
Incremental output omits the source text; horizontal cursor movement on the same
line starts no Git or rendering work. Recent results are kept in a small,
bounded, five-minute cache; short-lived negative entries prevent repeated Git
failures in non-repository and uncommitted files. Edits, saves, manual refresh,
and application focus changes invalidate relevant data. Line-end positions come
from Fresh's rendered-line updates, avoiding full-buffer reads or scans.

Commit patches are generated only when requested. They stream into a normal,
read-only Fresh file tab and are cached by immutable commit hash in the plugin
data directory.

## Development

Run the complete local validation suite:

```sh
make check
```

This type-checks both plugin and test builds, runs the unit/integration tests,
validates the package manifest, and asks Fresh to validate the plugin API.

## License

[MIT](LICENSE)
