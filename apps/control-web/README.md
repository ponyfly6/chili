# Chili Control Web

An independent mobile control page for the current Chili desktop workspace. It is
served by the desktop's private HTTPS host; it is not the marketing website.

Build with `bun run --cwd apps/control-web build`. The normal output is
`apps/control-web/dist`; desktop smoke builds set `CHILI_DESKTOP_BUILD_ROOT` and
instead write to that isolated root's `resources/control-web` directory. The
desktop serves these assets and `/api/` from the same HTTPS origin. Opening the
HTML directly, or using a plain HTTP development server, does not enable pairing.

The page uses the production `@chili/remote-control/browser` client. Credentials,
keys, request sequences and replay history share the page's in-memory lifetime.
Browser credentials are never written to local/session storage or IndexedDB,
and there is no service worker. Refresh or close the browser page and generate
a fresh one-time pairing code on the desktop. Disconnect / Reconnect within the
same page retains the stream and performs resync; an unconfirmed frame may be
delivered again with the same identity, never as a new command. Foreground and
network recovery trigger reconnection unless the user explicitly disconnected.

The interface only lists existing tasks and displays the public bounded snapshot
projection. The composer sends Queue or Steer, and Stop has its own action lane.
At most one list read and one snapshot read are in flight, with timer-after-settle
polling. Read requests do not own the send/stop locks. Supported ordinary model
questions have bounded answer cards and require a separate `sessions.input`
capability. Approval requests, MCP forms and questions outside the supported
projection still ask the user to return to the desktop.
An unknown send outcome clears that submitted draft and tells the user to inspect
the task before issuing another command; unknown operations are never submitted
as new commands during reconnection.
Unknown Queue, Steer, Stop and question-answer outcomes are retained separately from connection
and ordinary action notices, with the original task, a local reminder identity,
submission time and bounded prompt summary. Reconnecting, reading, selecting a
different task, clearing authorization or a later successful operation cannot
remove them. Only the explicit “已核对，清除此提醒” action clears the matching
warning, so concurrent Send and Stop uncertainties cannot overwrite one another.
Before sending each mutation, the browser writes a minimal pending marker to
localStorage: reminder ID, session ID, operation, start time and an optional
question ID. It stores no title, prompt, answer, credential, channel or replay
counter. A confirmed result clears that marker. Unknown results and interrupted
app lifetimes retain it; reloading restores a warning without task content and
without sending any command. Corrupt or unavailable reminder storage blocks
mutations. Writes to this journal are serialized so concurrent Send / Stop
operations cannot erase one another. The page also warns before navigation, but
correctness does not depend on mobile browsers firing that event.

`apps/mobile` embeds this same UI with the explicit `ControlAppPlatform` prop
declared in `src/platform.ts`. Only this native entry point shows a computer
address input; the ordinary browser client remains same-origin. Its
HTTPS transport keeps system certificate checks and its device identity lives
in Keychain/Keystore. Reopening the app establishes a fresh control channel
within the original host authorization lifetime; it never restores old replay
counters or automatically repeats unknown commands. Expired or revoked device
trust returns to pairing instead of retrying forever. Forgetting a computer
invalidates pending recovery attempts before removing its saved identity.
Before every native
mutation, a minimal pending record is saved to secure storage. App restart
restores that record as an outcome to verify, without storing prompt or answer
text. Native reminder and recovery storage use distinct secure-store records;
forgetting the computer does not erase unresolved reminders. This native adapter
does not enable browser credential persistence.

Run `bun run --cwd apps/control-web typecheck` and
`bun run --cwd apps/control-web test` for this app's focused checks. Actual
HTTPS/desktop/runtime acceptance is covered by the remote browser E2E suite.
Narrow viewport screenshots demonstrate browser layout only, not iPhone or Android
hardware acceptance.

The shared mobile interface uses `Workspace` for task navigation and conversation,
`QuestionSheets` for ordinary model questions, and `PairingView` for connection.
Task lists show real update times; only a task with a matching snapshot can show
its execution state. The single send button has an explicit Queue/Steer chooser,
while Stop remains independent. Message rendering supports a safe Markdown subset
without raw HTML or remote images.

Unsent drafts are kept separately for each task in memory. Question drafts survive
closing the panel and switching tasks, but are invalidated when the question
changes. Native reopening can restore the last task only after a fresh authorized
task list confirms it is still accessible. The remembered navigation record binds
the task ID to the host and device; it contains no credential or conversation text.
The app owns the safe-area insets and keyboard-aware viewport; connection forms
and question panels scroll within their available height.
