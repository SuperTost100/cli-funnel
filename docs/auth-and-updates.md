# Sign-in and updates

cli-funnel does not implement any login. It starts the CLI's own login command and turns what it prints into events your UI can show.

## Status

```ts
const status = await funnel.authStatus("claude");
// { loggedIn: true, method: "claude.ai", account: "you@example.com", plan: "pro" }
```

Fields other than `loggedIn` appear only when the CLI reports them.

## Sign in

```ts
const login = funnel.login("codex");

for await (const event of login) {
  switch (event.type) {
    case "open-url":     showLink(event.url); break;
    case "code-prompt":  login.sendCode(await askUser(event.message)); break;
    case "needs-terminal": showCommand(event.command); break;
    case "done":         console.log("signed in", event.status); break;
    case "error":        console.error(event.message); break;
  }
}
```

The CLI usually opens the browser itself. `open-url` gives you the link for UIs that want to show it, or for machines with no browser.

Some CLIs have no headless login. Antigravity is one. Its login emits `needs-terminal` with the command to run, then polls until the account is signed in.

`login.cancel()` stops the flow.

## Sign out

```ts
await funnel.logout("claude");
```

A provider whose CLI has no sign-out command throws an `unsupported` error that says how to sign out by hand.

## Update the CLI

```ts
const result = await funnel.update("codex");
// { from: "0.157.0", to: "0.158.0", changed: true, output: "..." }
```

This runs the CLI's own updater, so it works with however that CLI was installed. It reads the version before and after.

After an update, run `cli-funnel doctor`. If the new version is outside the tested range, `withinTestedRange` is false. That is a warning, not a block.

## In the UI

`FunnelLogin` from `cli-funnel-react` wraps all of this: status line, sign in, sign out, update, the sign-in link and the code box. See [UI components](ui.md).
