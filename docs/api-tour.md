# Try the API with curl

What a TV and its owner do, against the development server with the sample catalog: pair a TV, put shows on its Home,
play an episode and report its progress, then create an access token that sends a command and reads the event log.
Every route is in the [server API](spec/server-api-v1.md); the repository's commands are in
[AGENTS.md](../AGENTS.md#commands). It needs `curl` and `jq`. In a checkout, start `npm run -w server dev -- --config
server/izle.dev.json`, then in a second terminal:

```bash
B=http://localhost:8787; J='Content-Type: application/json'
dev() { npm run -s -w server dev -- "$@" --config server/izle.dev.json; }
ADMIN="Authorization: Bearer $(dev admin-token)"
START=$(curl -s -X POST $B/api/v1/pair/start); CODE=$(echo "$START" | jq -r .code)   # the TV shows a code
dev pair approve $CODE Living room                                                    # the owner approves it
WAIT=$(curl -s "$B/api/v1/pair/wait?code=$CODE" -H "Authorization: Bearer $(echo "$START" | jq -r .pairToken)")
DEVICE=$(echo "$WAIT" | jq -r .deviceId); TV="Authorization: Bearer $(echo "$WAIT" | jq -r .deviceToken)"
curl -s -X PUT $B/api/v1/admin/devices/$DEVICE/home -H "$ADMIN" -H "$J" -d '{"itemIds":["caminandes","sintel"]}' >/dev/null
curl -s $B/api/v1/tv/state -H "$TV" | jq -c '.home[] | {show: .item.title, next: .continue.episodeId}'
curl -s -X POST $B/api/v1/tv/resolve -H "$TV" -H "$J" -d '{"episodeId":"caminandes.s01e01"}' | jq -c '{sourceId, media}'
curl -s -X POST $B/api/v1/tv/progress -H "$TV" -H "$J" \
  -d '{"episodeId":"caminandes.s01e01","positionMs":90000,"durationMs":90000,"status":"finished"}'   # cursor moves on
AGENT="Authorization: Bearer $(dev token create Agent --scope control | tail -1)"                   # an access token
curl -s -X POST $B/api/v1/admin/devices/$DEVICE/commands -H "$AGENT" -H "$J" -d '{"type":"play","itemId":"sintel"}'
curl -s "$B/api/v1/admin/events?after=0&types=home.,command." -H "$AGENT" | jq -c '.events[] | {type, data}'
```

`curl -N $B/api/v1/tv/events -H "$TV"` follows the TV's live updates, `curl -N $B/api/v1/admin/events/stream -H
"$AGENT"` the event log.
