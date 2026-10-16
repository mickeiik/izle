# Try the API with curl

The flow a TV and its owner go through, against a development server serving the sample catalog
([server API](spec/server-api-v1.md)). Needs `curl` and `jq`. Start the server from the repository root:

```bash
npm ci
npm run -w server dev -- --config server/izle.dev.json            # sample catalog on :8787, state in server/data/
```

Then, in a second terminal:

```bash
B=http://localhost:8787; JSON='Content-Type: application/json'
ADMIN=$(npm run -s -w server dev -- admin-token --config server/izle.dev.json)
# 1. The TV asks for a pairing code and shows it on screen.
START=$(curl -s -X POST $B/api/v1/pair/start); CODE=$(echo "$START" | jq -r .code); PAIR=$(echo "$START" | jq -r .pairToken)
# 2. The owner approves it (or: npm run -s -w server dev -- pair approve $CODE Living room --config server/izle.dev.json).
curl -s -X POST $B/api/v1/admin/pair/approve -H "Authorization: Bearer $ADMIN" -H "$JSON" -d "{\"code\":\"$CODE\",\"name\":\"Living room\"}"; echo
# 3. The TV's long-poll receives its device token (exactly once).
WAIT=$(curl -s "$B/api/v1/pair/wait?code=$CODE" -H "Authorization: Bearer $PAIR")
DEVICE=$(echo "$WAIT" | jq -r .deviceId); TV=$(echo "$WAIT" | jq -r .deviceToken)
# 4. The owner puts shows on the TV's home screen, in order; 5. the TV reads it: what OK plays per show.
curl -s -X PUT $B/api/v1/admin/devices/$DEVICE/home -H "Authorization: Bearer $ADMIN" -H "$JSON" \
  -d '{"itemIds":["caminandes","tears-of-steel","big-buck-bunny"]}' | jq '.home[].itemId'
curl -s $B/api/v1/tv/state -H "Authorization: Bearer $TV" | jq '.home[] | {show: .item.title, next: .continue.episodeId, status: .continue.status}'
# 6. OK on Caminandes resolves the stream; 7. "finished" progress moves the show on to the next episode.
PLAY=$(curl -s -X POST $B/api/v1/tv/resolve -H "Authorization: Bearer $TV" -H "$JSON" -d '{"episodeId":"caminandes.s01e01"}')
echo "$PLAY" | jq '{sourceId, media, next: .next.episodeId}'
curl -s -X POST $B/api/v1/tv/progress -H "Authorization: Bearer $TV" -H "$JSON" \
  -d "{\"sessionId\":$(echo "$PLAY" | jq .sessionId),\"episodeId\":\"caminandes.s01e01\",\"positionMs\":90000,\"durationMs\":90000,\"status\":\"finished\"}"; echo
curl -s $B/api/v1/tv/state -H "Authorization: Bearer $TV" | jq '.home[0].continue | {episodeId, status}'   # caminandes.s01e02, new
```

Live updates for the TV stream from `GET /api/v1/tv/events` (server-sent events): run
`curl -N $B/api/v1/tv/events -H "Authorization: Bearer $TV"` and change the home list from another terminal.

Remote management, as an app or an agent would do it ([spec](spec/server-api-v1.md#remote-management)): an access
token with the `control` scope, the status, a `play` by show, what the TV made of it, and the history.

```bash
# 8. An access token for an agent (the secret is printed once); 9. every TV in one call, and the event log's position.
SECRET=$(npm run -s -w server dev -- token create Agent --scope control --config server/izle.dev.json | tail -1)
curl -s $B/api/v1/admin/status -H "Authorization: Bearer $SECRET" | jq '{lastEventId, devices: [.devices[] | {name, online, playing: .nowPlaying.episodeId}]}'
# 10. Play Caminandes on the TV (whatever OK would play for it); the TV acknowledges and reports the outcome.
CMD=$(curl -s -X POST $B/api/v1/admin/devices/$DEVICE/commands -H "Authorization: Bearer $SECRET" -H "$JSON" -d '{"type":"play","itemId":"caminandes"}' | jq .id)
curl -s -X POST $B/api/v1/tv/commands/$CMD/ack -H "Authorization: Bearer $TV" > /dev/null
curl -s -X POST $B/api/v1/tv/commands/$CMD/result -H "Authorization: Bearer $TV" -H "$JSON" -d '{"result":"done"}' > /dev/null
# 11. The events since the status was read, and the viewing history.
curl -s "$B/api/v1/admin/events?after=0&types=command." -H "Authorization: Bearer $SECRET" | jq -c '.events[] | {type, data}'
curl -s "$B/api/v1/admin/history/titles" -H "Authorization: Bearer $SECRET" | jq -c '.titles[] | {title, status, episodes}'
```

The stream form, `curl -N "$B/api/v1/admin/events/stream" -H "Authorization: Bearer $SECRET"`, delivers the same
events as they happen.
