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
There is no local/session storage, IndexedDB or service worker. Refresh or close
the page and generate a fresh one-time pairing code on the desktop. Disconnect /
Reconnect within the same page retains the stream and performs explicit resync;
it does not resend an admitted command.

The interface only lists existing tasks and displays the public bounded snapshot
projection. The composer sends Queue or Steer, and Stop has its own action lane.
At most one list read and one snapshot read are in flight, with timer-after-settle
polling. Read requests do not own the send/stop locks. Approval and input prompts
only show a request to return to the desktop, with no remote approval controls.
An unknown send outcome clears that submitted draft and tells the user to inspect
the task before issuing another command; there is no automatic mutation retry.

Run `bun run --cwd apps/control-web typecheck` and
`bun run --cwd apps/control-web test` for this app's focused checks. Actual
HTTPS/desktop/runtime acceptance is covered by the remote browser E2E suite.
Narrow viewport screenshots demonstrate browser layout only, not iPhone or Android
hardware acceptance.
