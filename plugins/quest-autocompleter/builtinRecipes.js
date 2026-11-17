/*
 * Recipes shipped with the plugin.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Some applications report quest progress through their own servers, so a quest cannot be
 * finished without following that application's own handshake. These recipes are the same
 * declarative documents a user can paste into the settings; shipping them means a supported
 * quest works out of the box and can still be inspected, edited or switched off.
 *
 * The Arise recipe was read from a real activity's own frontend, so it follows the same
 * handshake the application performs itself:
 *   POST /.proxy/acf/authorize      { code, activityId }        -> { token, access_token, user }
 *   POST /.proxy/acf/arise/register                           -> { authToken }
 *   POST /.proxy/acf/quest/progress { progress, quest_id }      -> { status: "ok" }
 * Every call carries X-Universe-ID, X-Discord-Activity-Id, X-Discord-Hostname and
 * X-Arise-Client, and the activity proxy needs the session ticket that also travels in the
 * iframe URL, so it is sent both as a query parameter and as the Referer.
 */

export const BUILT_IN_RECIPES = `[
  {
    "id": "arise-activity",
    "match": {
      "applicationId": "1557799582732124221",
      "taskTypes": ["ACHIEVEMENT_IN_ACTIVITY"]
    },
    "setup": [
      {
        "kind": "activityAuthorize",
        "headers": {
          "X-Universe-ID": "d5f3e8ae-12a3-4aa9-a0f0-25e1aa92416b",
          "X-Discord-Activity-Id": "{applicationId}",
          "X-Discord-Hostname": "{applicationId}.discordsays.com",
          "X-Arise-Client": "astronaut-prod-main-46567f6"
        },
        "save": { "ariseUserToken": "token", "proxyTicket": "ticketQuery", "referrer": "referrer" }
      },
      {
        "url": "https://{applicationId}.discordsays.com/.proxy/acf/arise/register?discord_proxy_ticket={proxyTicket}",
        "auth": "none",
        "headers": {
          "X-Auth-Token": "{ariseUserToken}",
          "X-Universe-ID": "d5f3e8ae-12a3-4aa9-a0f0-25e1aa92416b",
          "X-Discord-Activity-Id": "{applicationId}",
          "X-Discord-Hostname": "{applicationId}.discordsays.com",
          "X-Arise-Client": "astronaut-prod-main-46567f6",
          "Referer": "{referrer}"
        },
        "save": { "ariseToken": "authToken" }
      }
    ],
    "report": {
      "url": "https://{applicationId}.discordsays.com/.proxy/acf/quest/progress?discord_proxy_ticket={proxyTicket}",
      "auth": "none",
      "headers": {
        "X-Auth-Token": "{ariseToken}",
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
]`;
