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

### Dorion limitations

- `PLAY_ON_DESKTOP` and `STREAM_ON_DESKTOP` require Discord's native desktop runtime. Dorion uses the web client, so the plugin skips these tasks and continues the queue.
- Achievement processing is off by default in the Shelter port. Its requests need a `Referer` header, which Dorion 7.0.1's Tauri HTTP backend strips, so completion may fail. An achievement that fails is not retried until the plugin restarts.
- Video, activity, automatic enrollment, achievement, and auto-claim logic have automated tests with simulated Discord and Tauri responses. They have **not** been verified against a live Dorion session or Discord's servers.
- Auto-claim is off by default and needs a solver API key. The key is stored unencrypted in Shelter's local plugin storage and sent to the selected solver. A failed claim can be completed manually.
- Achievement attempts authorize an activity application. If cleanup is interrupted or ambiguous, check Discord's **Authorized Apps** settings. Even one newly found authorization cannot be conclusively tied to this plugin if another authorization for the same application is created concurrently.

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
