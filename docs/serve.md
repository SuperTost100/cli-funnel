# Run the server

`cli-funnel serve` starts an HTTP server in front of your installed CLIs. It speaks the cli-funnel API (used by the [UI components](ui.md)) and the OpenAI-compatible `/v1` endpoints (see [OpenAI compatibility](openai-compat.md)).

```bash
npx cli-funnel serve
```

By default it listens on `127.0.0.1:4747` and answers only requests that come from your own machine. The rest of this page covers how to change that safely.

## Flags

| Flag | Default | Effect |
|---|---|---|
| `--port <n>` | `4747` | Port to listen on. |
| `--host <address>` | `127.0.0.1` | Address to bind. Anything but `127.0.0.1` and `localhost` needs a token. |
| `--token <secret>` | none | Require `Authorization: Bearer <secret>` on every request. |
| `--cwd <dir>` | the current folder | Project folder for the OpenAI-compatible endpoints. |
| `--access <level>` | `accept-edits` | Access level for the OpenAI-compatible endpoints. See [Access levels](access-levels.md). |
| `--config <file>` | none | Read settings from a JSON file. |
| `--fs-root <dir>` | home folder and `--cwd` | Folder that runs may use as their project folder and the folder picker may browse. Repeat it for more. |
| `--approval-timeout <seconds>` | `300` | How long a `supervised` run waits for an answer before the request is denied. |
| `--cors <origin>` | off | One web origin that may call the API from a browser. See [CORS](#cors). |

`--fs-root` replaces the home folder default. Set it whenever the server is reachable by anyone else. A run whose `cwd` is outside every root is refused with 403, and symlinks are resolved before the check.

## Config file

`--config` reads a JSON file. The keys are the options of `createHandler` plus the flags above:

| Key | Same as |
|---|---|
| `port`, `host`, `cwd`, `access` | the flag of the same name |
| `token` | `--token`. Prefer `CLI_FUNNEL_TOKEN`, see below. |
| `fsRoots` | `--fs-root`, as a list |
| `approvalTimeoutSec` | `--approval-timeout` |
| `cors` | `--cors` |
| `allowedHosts` | `CLI_FUNNEL_ALLOWED_HOSTS`, as a list |
| `tailscale` | `false` stops accepting `*.ts.net` hosts from `tailscale serve` |
| `basePath` | Path prefix for every route, such as `/funnel` |
| `openai` | `{ "cwd": "...", "access": "..." }`. Overrides `cwd` and `access` for the `/v1` endpoints. |
| `openaiCompatible` | A list of `{ id, name, baseUrl, apiKey?, models? }`. Same as `CLI_FUNNEL_OPENAI_COMPATIBLE`. |

```json
{
  "host": "100.64.0.1",
  "fsRoots": ["/home/you/code"],
  "cwd": "/home/you/code",
  "approvalTimeoutSec": 120,
  "cors": "https://app.example.com"
}
```

A key the file does not know is an error, not a warning. A misspelled `fsRoots` would otherwise fall back to the default and open more than you meant to. Relative folders resolve against the file's folder.

A flag beats the file, and the file beats the environment. `--fs-root` replaces `fsRoots` instead of adding to it.

## Token and hosts

Without a token, the server answers only loopback addresses, IP addresses and `tailscale serve` names, and refuses requests from pages on other hosts. With a token, any client that sends it is accepted.

Set the token in the environment so it stays out of the process list:

```bash
CLI_FUNNEL_TOKEN=$(openssl rand -hex 32) npx cli-funnel serve --host 100.64.0.1
```

`--token` and the config file's `token` also work. The config file then holds a secret, so keep it readable by you only.

`CLI_FUNNEL_ALLOWED_HOSTS` and `allowedHosts` add host names to accept without a token. `.example.com` matches its subdomains. `*` turns the host check off, so use it only with a token.

## CORS

A browser app on another origin cannot call the server by default. Name that origin to allow it:

```bash
npx cli-funnel serve --token "$TOKEN" --cors https://app.example.com
```

The option takes one origin, written as the browser sends it: scheme, host and a port when it is not the default. A wildcard and a path are rejected at startup. For that origin the server answers the preflight request, which needs no token, and adds `Access-Control-Allow-Origin` to every response, including errors. Other origins get no CORS headers.

The origin check stays on. A page on any other origin is still refused when there is no token, and the `Host` check still applies to requests from the configured one. Set a token whenever you set `cors`, since the origin only says which page called, not who is using it.

## Run it on a tailnet

Bind the server to your tailnet address, with a token, and nobody outside the tailnet can reach it. `tailscale ip -4` prints the address.

```bash
CLI_FUNNEL_TOKEN=$(openssl rand -hex 32) npx cli-funnel serve --host "$(tailscale ip -4)" --fs-root ~/code
```

Do not publish the server with `tailscale funnel`. Funnel puts it on the public internet. The server refuses Funnel requests without a token, but a token is the only thing left in the way.

The [`deploy/`](../deploy) folder has two ready setups that do this.

### Docker Compose

[`deploy/compose.yaml`](../deploy/compose.yaml) builds an image with `cli-funnel`, Claude Code and Codex, and publishes port 4747 on the tailnet address only. Compose stops when the token or the address is missing.

```bash
cd deploy
cp compose.env.example .env
mkdir workspace
docker compose up -d --build
```

Fill in `TAILNET_IP` and `CLI_FUNNEL_TOKEN` in `.env` first. `workspace/` is mounted as `/workspace`, the only project folder runs can use. Point `WORKSPACE` at your code folder to use that instead. The folder must be writable by the container's `node` user. The `home` volume keeps CLI sign-ins between rebuilds.

Sign in once from the container:

```bash
docker compose run --rm funnel login claude
```

Edit the `CLIS` build argument in [`deploy/Dockerfile`](../deploy/Dockerfile) to change which CLIs the image holds.

### systemd

[`deploy/cli-funnel.service`](../deploy/cli-funnel.service) is a user unit. It runs as you, so the CLIs find their sign-ins in your home folder. The steps are in the comment at the top of the file. The unit reads the token from `~/.config/cli-funnel/env` and everything else from `~/.config/cli-funnel/serve.json`, which you copy from [`deploy/serve.example.json`](../deploy/serve.example.json). Set `host` in it to your tailnet address.

```bash
systemctl --user enable --now cli-funnel
journalctl --user -u cli-funnel -f
```
