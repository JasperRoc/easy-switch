# Codex task sync: setup and deployment

[简体中文教程](task-sync.zh-CN.md) · [README](../README.md)

Task sync transfers **selected Codex conversations and their project files** between computers. It preserves the conversation ID, saved history and local attachments. Git projects also retain commits, staged and unstaged changes, and untracked files. Ordinary folders, empty folders and repositories without a first commit are supported from 0.5.36. Version 0.5.40 automatically assigns a local project directory to new imports. Codex sign-ins and provider settings stay on their computer.

## 1. Choose your storage

| What you already use | Choose in easy-switch | What you need |
| --- | --- | --- |
| A Zotero account with **Zotero Storage** | Direct connection is unavailable | Separate WebDAV storage or your own server |
| **WebDAV** for Zotero attachments | **WebDAV** | The storage service's URL, username and app password; a separate folder |
| Nextcloud, a NAS, or another WebDAV service | **WebDAV** | The service's WebDAV endpoint and credentials |
| An SSH server without a domain | **Self-hosted server** | The sync service plus an SSH tunnel on each computer |
| A server and domain for direct network access | **Self-hosted server** | The sync service, DNS and HTTPS |

Zotero separates library data sync from attachment file sync; attachments can use Zotero Storage or WebDAV. easy-switch uses **WebDAV storage**, does not access a Zotero library, and does not accept a Zotero account or API key as WebDAV credentials. See [Zotero's official explanation](https://www.zotero.org/support/sync).

## 2. Reuse WebDAV storage you already use with Zotero

### Find the actual WebDAV credentials

1. Open Zotero **Settings → Sync → File Syncing**; names can differ by version or system.
2. Check whether personal-library attachments use **WebDAV** or **Zotero Storage**.
3. If WebDAV is selected, identify the storage service, URL and username. Obtain or create an app password from that service. You do not need to export your Zotero library.
4. If Zotero Storage is selected, prepare a separate WebDAV service or use the server instructions below.

### Create a dedicated folder

Use the storage service's web file manager or NAS to create `easy-switch`. **Keep it outside Zotero's managed `zotero` attachment directory.**

```text
WebDAV root/
├── zotero/        # Keep for Zotero
└── easy-switch/   # Create for easy-switch
```

Enter a complete HTTPS URL including the folder. Zotero may display the protocol separately or append `zotero` automatically; do not copy its entire field without checking the resulting path.

These are **address formats, not provisioned endpoints**:

| Service | Example easy-switch URL |
| --- | --- |
| Generic WebDAV | `https://dav.example.com/easy-switch/` |
| Nextcloud | `https://cloud.example.com/remote.php/dav/files/alice/easy-switch/` |
| NAS | The NAS's HTTPS WebDAV root followed by the dedicated folder |

Nextcloud shows the actual WebDAV URL in **Files settings → WebDAV** and provides app passwords for third-party clients; see its [official WebDAV guide](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html). For other services, use their documented endpoint. A browser file-manager URL or share link is not a WebDAV endpoint.

### Nutstore / Jianguoyun example

1. In Nutstore's web account, open account information → security → third-party applications and generate a separate app password for `easy-switch`. Do not use your website or Zotero password.
2. Create `easy-switch` at the root of your Nutstore files, alongside `zotero`.
3. Choose **WebDAV**, enter `https://dav.jianguoyun.com/dav/easy-switch/`, your actual Nutstore login account and the new app password. Set a separate encryption passphrase and keep it identical on every computer.
4. If a 403 remains, inspect the operation in the updated error: `PROPFIND` is directory reading, `MKCOL` is collection creation, and `PUT` is writing. A 403 alone does not prove a wrong password.

Earlier versions required conditional updates to a shared task pointer, which some WebDAV services do not enforce. Version 0.5.35+ writes every revision to a separate content-addressed file and preserves divergent branches. Verification now checks directory access, upload/read-back integrity and cleanup, without requiring ETags or atomic conditional writes. Error messages do not echo remote pages or credentials.

Nutstore documents WebDAV limits of 600 requests per 30 minutes for free accounts and 1,500 for paid accounts. Zotero and other clients also generate traffic; wait rather than repeatedly verifying when rate limited. easy-switch reuses directory-listing ETags to avoid one GET per unchanged task. See [Nutstore's app-password/access-limit documentation](https://help.jianguoyun.com/?p=2064) and [its official Zotero setup example](https://help.jianguoyun.com/?p=3168). End-to-end access with real Nutstore credentials has not been verified here; **Verify & save** checks the actual service connection. If a Nutstore directory listing reaches its documented 750-entry limit, synchronization stops instead of treating an incomplete listing as the entire history; pagination/automatic compaction is not yet implemented.

### Configure the first computer

Open easy-switch → **Settings → Task sync → Storage**:

| Field | Value |
| --- | --- |
| Storage type | **WebDAV** |
| Server URL | The complete HTTPS WebDAV URL of the new `easy-switch/` folder |
| Username | The WebDAV service username |
| WebDAV app password | The app/protocol password issued by that storage service |
| Shared encryption passphrase | Your own passphrase, at least 12 characters and identical on every computer; separate from the WebDAV password |
| Automatic sync | On |

Click **Verify & save**. The page moves to **Tasks**; select the conversations you want to upload and wait for **Synced**. Unselected local tasks are not uploaded.

Verification checks directory access, uploading, reading back identical bytes, and cleanup. ETags speed up queries where supplied, but are optional. Each encrypted package/revision has its own content-hash filename; two computers never overwrite a shared revision pointer. Concurrent branches remain on the server and appear as a conflict. Missing referenced ancestors or failed integrity checks stop application of the incoming state. Upgrade **every computer to 0.5.35+** before using the new journal; older clients do not understand its revision filenames. Existing legacy pointers remain readable by the new version.

## 3. Use your own server

Run this project's sync service on the server before adding it to the app. Entering an IP, SSH address or database address alone does not deploy it. The service stores encrypted packages in SQLite and serves HTTP(S); clients do not need a database driver or a public database port.

The following examples target Linux. Install Git, [Docker Engine](https://docs.docker.com/engine/install/) and the [Compose plugin](https://docs.docker.com/compose/install/linux/), then confirm `docker compose version`. Docker commands require access to the Docker daemon. A Node.js alternative follows below.

### 3.1 Download the deployment files and create a token

Run as your server user:

```bash
git clone https://github.com/JasperRoc/easy-switch.git
cd easy-switch/docs/sync-server
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Copy the random string, then edit `.env` in that directory:

```dotenv
SWITCH_SYNC_TOKEN=paste-your-random-string
SYNC_DOMAIN=sync.example.com
```

The token authorizes clients to the server. **The encryption passphrase is set separately in each client.** Keep both, and do not commit `.env`. `SYNC_DOMAIN` is unused when you run only the SSH-tunnel option.

### 3.2 Option A: no domain, connect through SSH

From `docs/sync-server` on the server:

```bash
docker compose up -d --build sync
docker compose ps
docker compose logs --tail=50 sync
```

The log should show `easy-switch sync server listening on port 18445`. Docker publishes this port only on the server's `127.0.0.1`, not on its public interfaces.

On **each computer running easy-switch**, start:

```bash
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:18445:127.0.0.1:18445 user@your-server
```

Replace `user@your-server` with your SSH user/address or an existing SSH alias. Use one line in Windows PowerShell. No output usually means the tunnel is established; leave the process running. Closing it disconnects sync. If the local port is occupied, change the first port after `-L` to `18446`, then use `http://127.0.0.1:18446/` in the client.

| Client field | Value |
| --- | --- |
| Storage type | **Self-hosted server** |
| Server URL | `http://127.0.0.1:18445/` |
| Server access token | `SWITCH_SYNC_TOKEN` from the server's `.env` |
| Shared encryption passphrase | The same passphrase of at least 12 characters on every computer |

This option requires a maintained SSH tunnel. For direct background access without a tunnel terminal, use HTTPS below. easy-switch currently does not start SSH tunnels for you.

### 3.3 Option B: domain and HTTPS

1. Point the DNS A/AAAA records for your sync domain to the server. Keep only records that are actually reachable.
2. Allow TCP **80 and 443** in the server firewall and cloud security group. If an existing website uses them, use its reverse proxy instead of starting a second listener.
3. Set `SYNC_DOMAIN` in `.env` to your real domain, **without a scheme, port or path**.
4. From `docs/sync-server`, run:

```bash
docker compose --profile https up -d --build
docker compose ps
docker compose logs --tail=50 caddy
```

The included Caddy configuration obtains/renews certificates and forwards sync requests. DNS and port reachability must satisfy [Caddy's automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https).

| Client field | Value |
| --- | --- |
| Storage type | **Self-hosted server** |
| Server URL | `https://sync.example.com/`, using your real domain |
| Server access token | `SWITCH_SYNC_TOKEN` from `.env` |
| Shared encryption passphrase | The same passphrase on every computer |

Do not enter a SQLite file URL or `http://public-server-IP:18445/`. Clients permit HTTPS, plus HTTP on loopback; ordinary remote HTTP is rejected.

If you already run Nginx, put this `location` inside a **dedicated HTTPS server block with a valid certificate**:

```nginx
location / {
    client_max_body_size 256m;
    proxy_pass http://127.0.0.1:18445;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

See the [official Nginx proxy documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) for these directives. Run only `docker compose up -d --build sync` in that case. Preserve Authorization, ETag and conditional headers, permit WebDAV methods, and avoid browser-interactive authentication on this domain. Opening the root URL in a browser may return 401 or 404; verify using easy-switch's **Verify & save** action.

### Without Docker: Node.js and systemd

The server requires Node.js **22.13+**; clients still support Node.js 20.18.1. Check `node --version` and `command -v node`, then prepare:

```bash
git clone https://github.com/JasperRoc/easy-switch.git "$HOME/easy-switch-sync"
mkdir -p "$HOME/.config/easy-switch-sync" "$HOME/.local/share/easy-switch-sync" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.config/easy-switch-sync" "$HOME/.local/share/easy-switch-sync"
openssl rand -hex 32
```

Write `~/.config/easy-switch-sync/server.env`, replacing the token and **absolute** database path. Run `chmod 600 ~/.config/easy-switch-sync/server.env` afterward:

```dotenv
SWITCH_SYNC_TOKEN=your-random-token
SWITCH_SYNC_DATABASE=/home/alice/.local/share/easy-switch-sync/sync.sqlite
SWITCH_SYNC_HOST=127.0.0.1
SWITCH_SYNC_PORT=18445
```

Create `~/.config/systemd/user/easy-switch-sync.service`. Use the absolute Node path from `command -v node` and your actual checkout path:

```ini
[Unit]
Description=easy-switch encrypted task sync
After=network.target

[Service]
ExecStart=/usr/bin/node /home/alice/easy-switch-sync/src/sync-server.js
EnvironmentFile=%h/.config/easy-switch-sync/server.env
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
```

This server uses only built-in Node modules; do not install desktop tooling or run `./install.sh` for it. Start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now easy-switch-sync.service
journalctl --user -u easy-switch-sync.service -n 50 --no-pager
```

For startup at boot and survival after SSH logout, enable user linger. An administrator can run `sudo loginctl enable-linger username` when necessary. Then connect through the SSH tunnel above, or use your existing HTTPS reverse proxy to reach `127.0.0.1:18445`.

### Update, back up, and stop the service

For Docker, run `git pull --ff-only` in the checkout, return to `docs/sync-server`, and rerun your original `docker compose ... up -d --build` command. For Node.js, pull the code and run `systemctl --user restart easy-switch-sync.service`.

Docker stores SQLite data in the `sync_data` named volume. `docker compose down` preserves it; **`docker compose down -v` deletes the database and synchronized data**. A simple offline backup is:

```bash
mkdir -p backups
docker compose stop sync
docker compose cp sync:/data/. ./backups/
docker compose start sync
```

Move backups to another secure location; avoid repeatedly overwriting the only backup. For Node deployments, stop the service, copy the database and any `-wal`/`-shm` files, then start it. Use SQLite's backup interface for online backups instead of copying only the main file. Restore the whole data directory while the service is stopped, retaining write permissions for the container's `node` user.

Keep the token and **encryption passphrase** separately. The encrypted database cannot restore conversation contents without the passphrase.

## 4. Receive tasks on the second computer

1. Install and run easy-switch, configure a usable Codex account or API locally, and enable Codex routing.
2. Open **Settings → Task sync → Storage**, enter the same server, credentials and shared passphrase, then click **Verify & save**.
3. Selected remote conversations appear in **Tasks**. From 0.5.40, easy-switch automatically restores their projects into `~/easy-switch-projects/<project-id>` on macOS or Linux and `%USERPROFILE%\easy-switch-projects\<project-id>` on Windows. With a custom `SWITCH_HOME`, the default `easy-switch-projects` folder is next to that directory. Previously mapped folders are reused.
4. Wait for **Synced**, then continue the same conversation in Codex. If the client filters the task list by project, open the local folder shown in the synced row.

From **0.5.42**, sync binds selected conversations to the local easy-switch route while Codex routing is enabled. Each computer uses its own provider selection and credentials. The next sync also repairs previously imported conversations, including when their content is already up to date. If Codex still has the old copy open, close the conversation or fully quit Codex to release it. Then click **Sync now**, wait for **Synced**, and reopen the same conversation. Keep Codex routing enabled when using these conversations.

Git projects restore to a detached HEAD at the synchronized commit, with staging and uncommitted changes retained. Other local branches are preserved. Ordinary folders restore their files without adding `.git`. Each destination still needs Git (also used for folder ignore rules), dependencies and external tools. Work on one computer at a time; if edits diverge, choose **Use this computer** or **Use server version** only after reviewing which version to retain. Upgrade every computer to **0.5.36+** when syncing ordinary folders.

Version **0.5.38+** also relocates Codex runtime workspace roots. Roots inside the synchronized project retain their relative position; ancestor directories and other roots outside it are narrowed to the mapped project folder. External workspace files are not copied and access is not expanded to a destination parent folder. Existing synchronized copies with foreign roots are backed up and repaired automatically after the task is released, including when the content revision is unchanged. On an affected Windows computer, close the conversation (fully quit Codex if it remains loaded), update easy-switch, click **Sync now**, then reopen the same task. Existing remote packages remain readable; deleting the task or storage is unnecessary.

Version **0.5.40** also addresses `EPERM` when Windows replaces local history. Synchronization acquires Codex's writer lock without opening the history for append. If Windows still blocks replacement, easy-switch keeps the original history and retries automatically.

**Automatic sync boundaries:** the normal interval is 30 seconds; tray operation continues, while sleep/offline conditions pause or back off work. Transfers contain completed turns, not running processes. A task or shared project still loaded in Codex blocks incoming replacement until released, so reopening that conversation may be necessary. Live refresh of an already-open window is not guaranteed.

## 5. Linux CLI

`switch sync` configures a client on the current machine; this is separate from the storage server. The existing easy-switch current-user service runs background transfers:

```bash
switch sync setup           # Prompt for backend, URL, credentials and passphrase
switch sync list            # Show task IDs, status and project=<key>
switch sync add <task-id>   # Select a local task for upload
switch sync project <project-key> /absolute/local/project  # Optional mapping override
switch sync now            # Optional: check immediately
switch sync remove <task-id>
switch sync resolve <task-id> local   # Or remote, to resolve a conflict
```

`setup` restarts the user's easy-switch service. Later sync does not require repeated `now` commands. Removing a selection stops that computer's synchronization without deleting local or remote conversations; other computers can deselect separately.

On Linux, task sync uses the system `flock` command for Codex writer locks. Repairing a saved provider in Codex's SQLite index uses Node.js 22.13+ or the `sqlite3` command on older Node.js runtimes.

## 6. Troubleshooting

| Symptom | Check |
| --- | --- |
| HTTP 401 / 403 | WebDAV app password or server token, directory permissions, and Authorization forwarding. The server token is not your SSH password |
| Codex returns HTTP 401 from `api.openai.com/v1/responses` in a synced conversation | Upgrade the destination to 0.5.42+, enable Codex routing, release the conversation, sync, and reopen it |
| HTTP 404 / 405 or unavailable collection | Complete protocol URL, existing parent directory, no share link, and reverse-proxy WebDAV method support |
| Old conditional-write error | Update every device to 0.5.35+ and verify again; immutable revision files no longer need atomic conditional overwrites |
| Incomplete revision journal / Nutstore listing limit | Retry after storage consistency recovers; do not delete ancestor revision files. At 750 listed entries, Nutstore sync pauses pending complete listing support |
| Decryption failed | All computers must use the original shared encryption passphrase; changing a storage password does not change the encryption passphrase |
| Connection failed | SSH tunnel, DNS/certificate/firewall, and any outbound proxy used by easy-switch |
| HTTP 413 / size limit | Reverse-proxy request-body limit or package size; encrypted packages are capped at 256 MiB |
| Waiting for an open task | Finish and release/close the destination conversation, wait for sync, then reopen |
| Windows history replacement reports `EPERM` | Update to 0.5.40+ and let automatic synchronization retry. If Codex still holds the file, close the destination conversation |
| `cannot restore workspace root` / `path is not absolute` after changing systems | Upgrade to 0.5.38+, release the destination Codex task, and sync again to replace the old host's runtime roots with the mapped project folder |
| Task row shows Sync failed | Read the localized reason directly below the task's folder. Verify Git is available, file permissions and size limits |
| Project conflict | Local project state diverged from the last sync; preserve important changes before choosing a version |
| Task missing from Codex sidebar | Same local user/`CODEX_HOME`, correct mapped project, refreshed task list; cloud-only tasks are outside this feature |

Current requirements/limits: Git must be installed, and Git projects must not contain submodules; 128 MiB Git bundle, 128 MiB history, 128 MiB folder/uncommitted data, 32 MiB per attachment/untracked file, 256 MiB encrypted package. Ordinary folders honor `.gitignore` and additionally exclude `.git`, `node_modules`, `.env`, `.env.*` and `.DS_Store`. Empty subdirectories are not preserved; the project root is created. Ignored files, dependencies, account configuration, complete execution environments, Git LFS objects, automatically running goals and subagent task trees are not fully migrated. Other files, including sensitive files not excluded by these rules, are included; secrets committed to Git remain part of the synchronized history.

Revision and object files accumulate to preserve branches; this version does not automatically garbage-collect remote history. Do not delete individual ancestor revisions. Existing clients may need to download all journal metadata once, then reuse it from memory.

Packages use AES-256-GCM with a key derived from the passphrase by scrypt before upload. The server still observes task identifiers, sizes and access timing. Local passphrases and credentials remain in easy-switch's private directory. Replaced histories remain in `CODEX_HOME/sync-backups`; project/conflict recovery copies remain in the sync cache. Complete uninstall deletes cache recovery copies; keep independent backups of important work.

Validation covers mock WebDAV protocol behavior, the SQLite service, round-trip continuation between isolated Codex homes and desktop integration. Commercial WebDAV providers, your public domain and your server environment have not all been tested.
