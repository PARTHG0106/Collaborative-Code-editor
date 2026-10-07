# Workspace experience improvements

## Minimal page design

The landing, dashboard, login, registration, and verification pages share a
restrained visual system: off-white or graphite surfaces, thin borders, compact
controls, and clear typography. The dashboard presents workspaces as rows;
the landing page pairs a short introduction with a code example. Decorative
background animation, glass effects, gradients, oversized welcome panels, and
the redundant profile card have been removed. Search, filtering, forms,
keyboard access, and the existing editor behavior remain available.

## Finding and organizing work

- Dashboard search matches workspace names and descriptions. Filter by your role,
  sort by name or date, and refresh to see newly added memberships.
- Pin workspaces to keep them first within the chosen sort. **Pinned only** works
  with search and role filters. Pins are personal to the signed-in account on
  this browser and synchronize between its tabs.
- Workspace creation keeps its draft and displays errors inside the dialog.
  Keyboard focus stays in the dialog and returns to its trigger when closed.
- Open any file with **Ctrl/Cmd+P**. Search by folder or file name; arrow keys
  choose a result and Enter opens it. Full paths distinguish duplicate names.
- **Ctrl/Cmd+B** toggles the sidebar, **Ctrl/Cmd+Shift+F** opens workspace
  search, and **Ctrl/Cmd+`** toggles the terminal.
- Content search reports invalid regular expressions and opens matching lines
  after the selected file has synchronized. Results are capped at 200 lines.
- Focus mode hides both side panels and restores their previous visibility.
- Returning to a workspace restores up to 50 open file tabs, the active file,
  cursor positions, and expanded folders. Deleted files are skipped; explicit
  search results still open at their matching line. Closing tabs updates the
  saved session, including when all tabs are closed.
- Sessions are saved per account and workspace on this browser. They contain
  navigation metadata only; file contents load from the server. Existing unsaved
  change warnings still apply, and a failed initial load does not erase a session.
  If loading is retried, any tabs or folders changed during the wait take
  precedence over the previous session.

## Personal settings and collaboration

- Settings offers font size, tab size, word wrap, and minimap preferences.
  Preferences persist in this browser and do not alter teammates' settings.
- Workspace settings and invitation forms retain drafts on failed submissions.
- Chat accepts multiple lines with Shift+Enter. Enter sends a message.
  Drafts clear after the server confirms storage; failures and uncertain
  delivery retain the draft. Uncertain delivery is never retried automatically.
- Viewers may participate in chat while their file access remains read-only.
  Messages longer than 4,000 characters are rejected rather than truncated.
- Incoming messages preserve the reader's scroll position and offer a jump to
  the latest message. Unread badges account for the selected collaboration tab.
- Presence, loading, and history errors have explicit feedback and recovery.

## Downloading workspace files

- The Explorer's download button creates a ZIP of its files and folders. Each
  file row also has a download action, available to viewers as well as editors.
- Downloads read a fresh authorized listing and include current editor buffers,
  including changes that have not finished saving. Historical snapshot previews
  do not replace live file contents in downloads. Preserved recovery copies keep
  their separate download buttons.
- ZIPs retain nested paths and empty folders. Recognized binary uploads are
  restored to bytes; source and text files remain UTF-8 text. Invalid paths,
  ambiguous extraction names, and failed requests produce visible errors.
- Downloads support up to 50 MiB of file contents and 5,000 ZIP entries. Files
  created only in the terminal, including installed dependencies, must first be
  added to the Explorer to appear in these exports.

## Jupyter notebooks

- Open `.ipynb` files as editable cells. Run a cell or use **Run All**; Python
  variables remain available to later cells in that notebook during the current
  workspace visit. Different notebooks use separate variable namespaces.
- **Ctrl/Cmd+Enter** runs the current code cell and keeps focus there.
  **Shift+Enter** runs it and focuses the next cell, adding a code cell at the
  end when needed. Markdown and raw cells advance without running Python.
  Execution shortcuts are disabled while running or when editing is read-only.
- Expression results, printed text, errors, and imported rich outputs are shown
  below their cells. Saves preserve notebook metadata, cell metadata, attachments,
  and raw cells. Invalid notebook JSON displays an error without replacing it.
- Browser Python loads supported imports automatically. `%pip install` and
  `!pip install` support Pyodide packages and compatible pure-Python wheels;
  arbitrary shell commands and native platform wheels are not supported.
- Expand **Python input** to supply one line per `input()` call. Lines start at
  the beginning for each cell run or Run All sequence and are kept only in memory.
  Without supplied lines, a native prompt is used where the browser supports it.
- Runs are serialized. Stop cancels queued work and Python tasks waiting on
  async operations; it resets that notebook's variables. A tight synchronous
  Python loop still runs on the browser's main thread and cannot be interrupted
  by the Stop button. Switching files cancels an active run; completed notebook
  kernels survive tab switches until the workspace is closed or reloaded.

## Sign-in and accessibility

- Login, registration, and verification preserve the requested workspace route.
- Google sign-in is available on login and registration when the server's
  public client ID is configured. Existing eligible accounts retain their
  identity, password, and workspaces; see [Google sign-in](google-sign-in.md)
  for configuration and account-linking rules.
- Password visibility, autofill, verification-code paste, and separate resend
  status reduce friction in authentication forms.
- Keyboard controls, visible focus, field labels, screen-reader feedback,
  reduced-motion preferences, and small-screen layouts are improved.
- The landing service badge reflects the health check and offers retry.
- Decorative mouse feedback no longer rerenders the whole page per movement.

## Validation and release

Run the frontend and server suites, production build, and lint before release.
Automated coverage includes chat delivery, navigation, editor preferences, and
Google token verification, challenge replay prevention, and account linking.
Earlier browser checks used synthetic data in an isolated local API fixture
for dashboard filtering, mobile editor navigation, search line jumps, chat
failure/retry, and editor preference persistence. Google popup sign-in requires
a separate check with the configured OAuth client and a real account.

The Google sign-in addition requires the committed
`20261005000000_add_google_auth` database migration. Deploy the updated backend
and apply its migrations before releasing the frontend. The backend also
provides chat acknowledgments: a new frontend talking to the old backend cannot
confirm delivery and will retain chat drafts after its timeout. Older frontend
clients remain compatible with the updated backend. Follow the
[Google sign-in release steps](google-sign-in.md#migration-and-release-order)
for environment setup and verification.
