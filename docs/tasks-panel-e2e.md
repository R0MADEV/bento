# Tasks panel end-to-end test

The task workflow has a dependency-free W3C WebDriver test that launches the
real Bento binary through a test-only embedded driver. It creates disposable Git repositories
and covers a UI commit, rebase drag-and-drop, recovery after restarting Bento,
an actual rebase conflict, and backup discovery.

Build the isolated test binary, then run the same test on Windows, Linux, or
macOS:

```sh
npm run build:e2e:app
BENTO_E2E_APP="$PWD/src-tauri/target/debug/bento" npm run test:e2e:tasks
```

On PowerShell, set the executable with:

```powershell
$env:BENTO_E2E_APP="$PWD\src-tauri\target\debug\bento.exe"
npm run test:e2e:tasks
```

The build uses the identifier `com.romadev.bento.e2e`, a separate WebView data
directory on Windows/Linux, and a separate WKWebsiteDataStore on macOS. The
runner refuses to continue when given a normal Bento binary, then clears only
that isolated E2E store before and after each run.

The WebDriver plugin is optional and is never registered in normal production
builds. For native external drivers on Windows or Linux, set
`BENTO_E2E_PROVIDER=external`; `TAURI_DRIVER` can select a custom executable.
`BENTO_E2E_DRIVER_URL` connects to an already managed driver on any platform.
