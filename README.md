# QuestAutocompleter — Shelter port

**This is a [Shelter](https://shelter.uwu.network/) plugin for [Dorion](https://github.com/SpikeHD/Dorion), not a Vencord plugin.** It installs from a URL inside Discord's Shelter settings and runs in the web client Dorion hosts. It is not installed through Vencord's plugin folder, and the Vencord plugin it was ported from is untouched.

Install in Dorion — Discord **User Settings → Shelter → Plugins → Install Plugin**:

```text
https://jus1-c.github.io/discord-quest-autocompleter/quest-autocompleter/
```

What it does: auto-completes Discord quests. It can auto-accept quests, queue them, run video, desktop, stream and activity progress until they finish, and auto-claim if given a captcha solver API key. It handles reloads, account switches and mid-session enabling without breaking.

Everything about this build — install, settings, supported activity protocols, Dorion limits — is in [Shelter / Dorion](#shelter--dorion) below. The sections after it that are marked *upstream* describe the original Vencord plugin this was ported from and do not apply to this build.

## ⚠️ Disclaimer

This plugin automates Discord quest progress. Use it at your own risk and make sure you understand Discord's Terms of Service.

I am not responsible for any account actions, flags, or bans that may occur from using this plugin.

The upstream quest script reports that Discord has suspended quest access for users caught automating quests. See its [warning](https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb) before using this plugin.

## Supported tasks

The Shelter port runs these, with the limits described in [Dorion limitations](#dorion-limitations):

- WATCH_VIDEO
- WATCH_VIDEO_ON_MOBILE
- PLAY_ON_DESKTOP
- STREAM_ON_DESKTOP
- PLAY_ACTIVITY
- ACHIEVEMENT_IN_ACTIVITY

Desktop app tasks get skipped on web.

## Shelter / Dorion

The Shelter port is separate from the Vencord plugin. It targets Dorion's web client and does not require a custom Dorion build.

### Install from a URL

Repository: <https://github.com/jus1-c/discord-quest-autocompleter>

1. Open Discord **User Settings → Shelter → Plugins → Install Plugin** in Dorion and enter:

   ```text
   https://jus1-c.github.io/discord-quest-autocompleter/quest-autocompleter/
   ```

   That URL serves the built `plugin.json` and `plugin.js` of the `main` branch, not the GitHub source page. Shelter fetches updates from the same URL, so a new build on `main` arrives the next time the plugin is loaded.

2. The build and deployment run in GitHub Actions (`.github/workflows/shelter-pages.yml`): it runs the tests, builds with Lune and publishes `dist/` to GitHub Pages. **Pages** must be set to **GitHub Actions** as its source in the repository settings; after that, every push to `main` publishes by itself.

Only install plugins from a source you trust: the URL owner can change the plugin code later.

For local development:

```sh
npm ci --ignore-scripts
npm test
npm run build
```

The output is in `dist/quest-autocompleter/`.

### Settings

Open the gear icon on the plugin card in **Shelter → Plugins**.

- **Enable automated quests** — master switch. Turning it off stops the running task, the queue and every new request.
- **Accept new quests automatically** — off by default. With it off the plugin only works on quests you accepted yourself.
- **Prefer the desktop task** — on by default. A quest can offer several platforms (for example desktop, Xbox and PlayStation at once); with this on the plugin runs the desktop task instead of the first one the quest lists. It never changes the platform your reward is redeemable on.
- **Quest families** — video, play desktop and activity are on; stream desktop and achievement are off because both are experimental.
- **Claim rewards automatically** — off by default, plus the CAPTCHA solver and its API key.
- **Advanced** — quest refresh interval, desktop heartbeat interval, desktop user agent override, console logging, built-in recipes, custom adapters and **Copy diagnostics**.

Activity quests are the only family whose console output explains itself before anything is attempted:

```
[QuestAutocompleter] Activity quest "<quest name>": apps [<application id>], built-in: arise-activity | custom: none
[QuestAutocompleter] Activity protocol: recipe:arise-activity for "<quest name>"
```

The first line is there so a quest that is not finishing can be diagnosed without a debugger: it lists every application id the quest carries and which recipes parsed (or the first parse problem).

### Quests the plugin cannot run

Console-only quests (`PLAY_ON_XBOX`, `PLAY_ON_PLAYSTATION`), quests whose tasks are joined with `"join_operator": "and"`, and activities whose protocol has no adapter are reported once in the console with the task types they offer, and skipped without blocking the rest of the queue.

**Copy diagnostics** (Advanced) prints and copies a redacted snapshot: quest and application IDs, task types and targets, join operator, progress timestamps and which adapter matched. It contains no token, cookie or request header. Paste it when asking for support.

Application-tracked quests live in `adapters.js`. Each protocol is one adapter with a `matches` probe; adding support for a new activity means adding an adapter, not editing the engine.

### Custom adapters (recipes)

A quest whose application reports its own progress can often be supported without a new build. Recipes are checked in this order: the built-in ones first (see **Use built-in recipes**), then **Advanced → Custom adapters (JSON)**, then the adapters compiled into the plugin. Turn the built-in switch off when you want your own recipe to take over one of those quests.

```json
[
  {
    "id": "example",
    "match": { "applicationId": "1234567890", "taskTypes": ["ACHIEVEMENT_IN_ACTIVITY"], "eventName": "progress" },
    "report": {
      "url": "https://discord.com/api/v9/quests/{questId}/heartbeat",
      "body": { "application_id": "{applicationId}", "value": "{value}" },
      "valueField": "progress.ACHIEVEMENT_IN_ACTIVITY.value",
      "step": 1,
      "intervalSeconds": 20
    },
    "finish": { "url": "https://discord.com/api/v9/quests/{questId}/heartbeat", "body": { "terminal": true } }
  }
]
```

- `match` needs at least one of `applicationId`, `questId`, `taskTypes`, `eventName`, so a recipe only runs on the quests it names.
- `report` is sent repeatedly; `{value}` climbs by `step` (or jumps to `target` with `"step": "target"`) until Discord reports `completed_at` or the value reaches the target.
- Placeholders: `{questId}`, `{applicationId}`, `{target}`, `{value}`, `{attempt}`, `{eventName}`. A numeric placeholder stays a number in the JSON body.
- `valueField` is the dotted path to the server's reported progress; leave it out when the endpoint only answers with `completed_at`.
- `finish` is sent once at the end and is optional.

Safety limits: a recipe may only call `https://discord.com/api/vN/...` or `https://{applicationId}.discordsays.com/...`, cannot set `Authorization`, `Cookie` or `Host`, the interval is clamped to 5-120 seconds, and the document is capped at 8000 characters. Recipes are declarative JSON — no pasted code is executed. A recipe is still only as good as the request it names: Discord may reject progress the application never produced.

Recipes also accept a `setup` array that runs before the progress loop. A setup step can be a plain request with `"save": { "name": "dotted.path" }` to keep a value for later steps, or `{ "kind": "activityAuthorize", "save": { "token": "token" } }` to reuse the plugin's own OAuth handshake (the account token never leaves Discord's hosts). A later step may use anything an earlier step saved, and an `activityAuthorize` step may carry the activity's own protocol with `"headers"` and `"body"` (placeholders filled in). Use `"auth": "none"` on any request sent to an activity host. `report.successPath` names the field the server answers with on success (`"ok"` by default) so a rejected progress call fails loudly instead of looking finished.

An activity request has no cookies and no iframe, so the activity proxy ticket that the activity itself gets from its iframe URL is saved as `{proxyTicket}` (percent-encoded; the raw value is `{ticket}`) and repeated in the URL (`...?discord_proxy_ticket={proxyTicket}`) as well as in the `Referer`, which is `{referrer}`, the full iframe URL.

Setup steps are retried up to three times, one second apart, and the activity authorization the same way, because a first call in a session can be refused and succeed immediately afterwards. The progress `report` is never retried, so progress cannot be counted twice. A refused request reports the status and the server's answer (with tokens, codes and secrets replaced) instead of a bare "failed".

#### Shipped recipe: Arise activities

`builtinRecipes.js` ships one recipe, `arise-activity`, for the application `1557799582732124221`. It was read from the activity's own frontend: authorize, register a session, then report `{ progress, quest_id }` and expect `{ "status": "ok" }`, on a five second throttle.

Two tokens are involved and they are not interchangeable. The authorize token authenticates the `/.proxy/acf/*` calls, which is why the progress report uses it; the `authToken` from the register call authenticates the application's main `/.proxy/api/*` API instead, and the quest endpoints reject it with `Unable to get user info from auth token`.

```json
[
  {
    "id": "arise-activity",
    "match": { "applicationId": "1557799582732124221", "taskTypes": ["ACHIEVEMENT_IN_ACTIVITY"] },
    "setup": [
      {
        "kind": "activityAuthorize",
        "headers": {
          "X-Universe-ID": "d5f3e8ae-12a3-4aa9-a0f0-25e1aa92416b",
          "X-Discord-Activity-Id": "{applicationId}",
          "X-Discord-Hostname": "{applicationId}.discordsays.com",
          "X-Arise-Client": "astronaut-prod-main-46567f6"
        },
        "save": { "questToken": "token", "proxyTicket": "ticketQuery", "referrer": "referrer" }
      },
      {
        "url": "https://{applicationId}.discordsays.com/.proxy/acf/arise/register?discord_proxy_ticket={proxyTicket}",
        "auth": "none",
        "headers": {
          "X-Auth-Token": "{questToken}",
          "X-Universe-ID": "d5f3e8ae-12a3-4aa9-a0f0-25e1aa92416b",
          "X-Discord-Activity-Id": "{applicationId}",
          "X-Discord-Hostname": "{applicationId}.discordsays.com",
          "X-Arise-Client": "astronaut-prod-main-46567f6",
          "Referer": "{referrer}"
        },
        "save": { "accountToken": "authToken" }
      }
    ],
    "report": {
      "url": "https://{applicationId}.discordsays.com/.proxy/acf/quest/progress?discord_proxy_ticket={proxyTicket}",
      "auth": "none",
      "headers": {
        "X-Auth-Token": "{questToken}",
        "X-Universe-ID": "d5f3e8ae-12a3-4aa9-a0f0-25e1aa92416b",
        "X-Discord-Activity-Id": "{applicationId}",
        "X-Discord-Hostname": "{applicationId}.discordsays.com",
        "X-Arise-Client": "astronaut-prod-main-46567f6",
        "Referer": "{referrer}"
      },
      "body": { "progress": "{value}", "quest_id": "{questId}" },
      "step": 1,
      "intervalSeconds": 6,
      "successPath": "status",
      "successEquals": "ok"
    }
  }
]
```

The activity throttles progress to one report every five seconds, so the interval stays above that.

Keep only one recipe per quest. If a custom recipe for the same application is broken, turn **Use built-in recipes** back on and empty the custom textarea rather than debugging both at once.

### Dorion limitations

- `PLAY_ON_DESKTOP` runs through Dorion's native HTTP client (`@tauri-apps/plugin-http`) instead of Discord's web transport. Discord rejects quest heartbeats whose user agent has no Electron version, so the plugin sends each heartbeat with a desktop user agent and a matching `X-Super-Properties` header. Only quest requests carry that identity; chat and everything else stay on the normal web session. This path has **not** been confirmed against Discord's servers, so treat a completed quest as the only proof: check that progress rises and survives a reload.
- `STREAM_ON_DESKTOP` is opt-in and experimental. Discord validates that a real stream exists and that someone else is watching it, and only trusts the client about which application the stream belongs to. The plugin therefore waits for a stream you started yourself, then heartbeats with that stream's real key through the same native transport. It does not fake the stream or the viewer, and it has **not** been verified end to end.
- Achievement processing is off by default in the Shelter port. It needs the activity's own OAuth handshake, and the activity proxy expects the session ticket in the request: Dorion 7.0.1's Tauri HTTP backend may drop the `Referer` header, so the ticket is also sent as a `discord_proxy_ticket` query parameter. When a handshake is refused the console now prints the HTTP status and the server's answer (with tokens and codes redacted) instead of a bare "failed". An achievement that fails is not retried until the plugin restarts.
- Video, activity, automatic enrollment, achievement, auto-claim, desktop and stream heartbeat logic have automated tests with simulated Discord and Tauri responses. They have **not** been verified against a live Dorion session or Discord's servers.
- Auto-claim is off by default and needs a solver API key. The key is stored unencrypted in Shelter's local plugin storage and sent to the selected solver. A failed claim can be completed manually.
- Achievement attempts authorize an activity application. If cleanup is interrupted or ambiguous, check Discord's **Authorized Apps** settings. Even one newly found authorization cannot be conclusively tied to this plugin if another authorization for the same application is created concurrently.

### Desktop heartbeat settings

- **Desktop heartbeat interval** — seconds between heartbeats, 15-110. Discord credits at most two minutes of progress per heartbeat, so a shorter interval is pointless but a longer one loses time.
- **Desktop user agent override** — leave empty to generate one from the current platform. Any value you type must contain `Electron/<version>`; the generated `X-Super-Properties` is derived from it so the two agree.

## Setup/Install (upstream Vencord plugin)

This section is about the original Vencord plugin and does not describe this build. For this build see [Install from a URL](#install-from-a-url).

Download `questAutocompleter.zip` from the latest release. Unzip, and make sure there is only 1 folder housing the 2 files inside it. 

Paste the folder into `Vencord/src/plugins/`, mimicking the same file structure as other plugins. Rebuild Vencord (`pnpm build`), enable in settings.

Auto-accept & auto-claim are off by default, toggle them in plugin settings if you want quests enrolled and/or claimed automatically. Auto-claim requires more setup as it needs an external captcha solver API key.

The plugin asks Discord for new quests every 2 hours. Change that in settings, minimum is 30 minutes.

Vencord must be built from source: https://docs.vencord.dev/installing/

## Achievement quests (upstream)

In the Vencord version, achievement quests (earn badges inside an activity) are handled automatically via OAuth. The plugin authorizes itself with the activity, then fires off the badge completion request after a realistic-seeming amount of time. On by default there, can be toggled with "Achievement Bypass" in settings. See the Shelter limitations above for Dorion.

## Auto-claim

When a quest finishes, the plugin can automatically claim the reward for you. This requires a captcha solver since Discord gates claims behind hCaptcha.

Turn on "Auto Claim" in settings, pick a solver (NopeCHA, CapSolver, or 2Captcha), and paste your API key. If the solve fails or the key is missing, the quest just stays completed without claiming -- you can still claim manually.

## Credit

Quest completion logic based on https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb

## License

GPL-3.0
