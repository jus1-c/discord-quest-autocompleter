# QuestAutocompleter

Vencord plugin that auto-completes Discord quests. Can auto-accept quests, queue them, spoof game/stream/video progress until they're done, and auto-claim if given a captcha solver API key.

Handles reloads, account switches, and mid-session enabling without breaking.

## ⚠️ Disclaimer

This plugin automates Discord quest progress. Use it at your own risk and make sure you understand Discord's Terms of Service.

I am not responsible for any account actions, flags, or bans that may occur from using this plugin.

The upstream quest script reports that Discord has suspended quest access for users caught automating quests. See its [warning](https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb) before using this plugin.

## Supported tasks

The following applies to the original Vencord plugin. The Shelter port has additional limitations described below.

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

The plugin must first be published. Adding the source files to a repository alone does not make the URL available.

1. Push the changes to the repository's `main` branch.
2. In GitHub repository settings, open **Pages** and select **GitHub Actions** as the build and deployment source.
3. Run the **Build and deploy Shelter plugin** workflow, or push another commit to `main`. Wait for the workflow to succeed.
4. In Dorion, open Discord **User Settings → Shelter → Plugins → Install Plugin**, then enter:

   ```text
   https://<owner>.github.io/<repository>/quest-autocompleter/
   ```

   Replace `<owner>` and `<repository>` with the GitHub account and repository name. The URL serves the built `plugin.json` and `plugin.js`, not the GitHub source page.

The workflow runs tests and builds with Lune before deploying. Shelter can fetch updates from the same URL. Only install plugins from a source you trust: the URL owner can change the plugin code later.

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
- **Advanced** — quest refresh interval, desktop heartbeat interval, desktop user agent override, console logging and **Copy diagnostics**.

### Quests the plugin cannot run

Console-only quests (`PLAY_ON_XBOX`, `PLAY_ON_PLAYSTATION`), quests whose tasks are joined with `"join_operator": "and"`, and activities whose protocol has no adapter are reported once in the console with the task types they offer, and skipped without blocking the rest of the queue.

**Copy diagnostics** (Advanced) prints and copies a redacted snapshot: quest and application IDs, task types and targets, join operator, progress timestamps and which adapter matched. It contains no token, cookie or request header. Paste it when asking for support.

Application-tracked quests live in `adapters.js`. Each protocol is one adapter with a `matches` probe; adding support for a new activity means adding an adapter, not editing the engine.

### Custom adapters (recipes)

A quest whose application reports its own progress can often be supported without a new build. Paste a recipe into **Advanced → Custom adapters (JSON)** and the plugin runs it before the built-in adapters.

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

### Dorion limitations

- `PLAY_ON_DESKTOP` runs through Dorion's native HTTP client (`@tauri-apps/plugin-http`) instead of Discord's web transport. Discord rejects quest heartbeats whose user agent has no Electron version, so the plugin sends each heartbeat with a desktop user agent and a matching `X-Super-Properties` header. Only quest requests carry that identity; chat and everything else stay on the normal web session. This path has **not** been confirmed against Discord's servers, so treat a completed quest as the only proof: check that progress rises and survives a reload.
- `STREAM_ON_DESKTOP` is opt-in and experimental. Discord validates that a real stream exists and that someone else is watching it, and only trusts the client about which application the stream belongs to. The plugin therefore waits for a stream you started yourself, then heartbeats with that stream's real key through the same native transport. It does not fake the stream or the viewer, and it has **not** been verified end to end.
- Achievement processing is off by default in the Shelter port. Its requests need a `Referer` header, which Dorion 7.0.1's Tauri HTTP backend strips, so completion may fail. An achievement that fails is not retried until the plugin restarts.
- Video, activity, automatic enrollment, achievement, auto-claim, desktop and stream heartbeat logic have automated tests with simulated Discord and Tauri responses. They have **not** been verified against a live Dorion session or Discord's servers.
- Auto-claim is off by default and needs a solver API key. The key is stored unencrypted in Shelter's local plugin storage and sent to the selected solver. A failed claim can be completed manually.
- Achievement attempts authorize an activity application. If cleanup is interrupted or ambiguous, check Discord's **Authorized Apps** settings. Even one newly found authorization cannot be conclusively tied to this plugin if another authorization for the same application is created concurrently.

### Desktop heartbeat settings

- **Desktop heartbeat interval** — seconds between heartbeats, 15-110. Discord credits at most two minutes of progress per heartbeat, so a shorter interval is pointless but a longer one loses time.
- **Desktop user agent override** — leave empty to generate one from the current platform. Any value you type must contain `Electron/<version>`; the generated `X-Super-Properties` is derived from it so the two agree.

## Setup/Install (Vencord)

Download `questAutocompleter.zip` from the latest release. Unzip, and make sure there is only 1 folder housing the 2 files inside it. 

Paste the folder into `Vencord/src/plugins/`, mimicking the same file structure as other plugins. Rebuild Vencord (`pnpm build`), enable in settings.

Auto-accept & auto-claim are off by default, toggle them in plugin settings if you want quests enrolled and/or claimed automatically. Auto-claim requires more setup as it needs an external captcha solver API key.

The plugin asks Discord for new quests every 2 hours. Change that in settings, minimum is 30 minutes.

Vencord must be built from source: https://docs.vencord.dev/installing/

## Achievement quests

In the Vencord version, achievement quests (earn badges inside an activity) are handled automatically via OAuth. The plugin authorizes itself with the activity, then fires off the badge completion request after a realistic-seeming amount of time. On by default there, can be toggled with "Achievement Bypass" in settings. See the Shelter limitations above for Dorion.

## Auto-claim

When a quest finishes, the plugin can automatically claim the reward for you. This requires a captcha solver since Discord gates claims behind hCaptcha.

Turn on "Auto Claim" in settings, pick a solver (NopeCHA, CapSolver, or 2Captcha), and paste your API key. If the solve fails or the key is missing, the quest just stays completed without claiming -- you can still claim manually.

## Credit

Quest completion logic based on https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb

## License

GPL-3.0
