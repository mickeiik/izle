#!/usr/bin/env bash
# Generates real, playable media for the example upstream (needs ffmpeg with libx264 and drawtext): a test
# pattern with a running clock as HLS — one H.264 rendition, English and Turkish audio renditions (two tones),
# English WebVTT subtitles — plus the same as a progressive MP4. Everything is synthetic; nothing is downloaded.
#
#   server/examples/resolver-example/make-media.sh <output dir> [seconds, default 600]
#   node server/examples/resolver-example/upstream.js --media <output dir>
set -euo pipefail

out=${1:?usage: make-media.sh <output dir> [seconds]}
seconds=${2:-600}
dir="$out/demo"
rm -rf "$dir"
mkdir -p "$dir/video/360p" "$dir/audio/en" "$dir/audio/tr" "$dir/subs/en"
hls=(-f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments)

ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=25" -t "$seconds" \
  -vf "drawtext=text='izle proxy demo  %{pts\\:hms}':fontsize=30:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=24:y=24" \
  -c:v libx264 -preset veryfast -profile:v main -level 3.0 -pix_fmt yuv420p -b:v 500k -maxrate 600k -bufsize 1200k \
  -g 50 -keyint_min 50 -sc_threshold 0 -an \
  "${hls[@]}" -hls_segment_filename "$dir/video/360p/seg%03d.ts" "$dir/video/360p/index.m3u8"

for spec in en:440 tr:660; do
  lang=${spec%%:*}
  freq=${spec##*:}
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=$freq:sample_rate=48000" -t "$seconds" \
    -c:a aac -b:a 64k -ac 2 -metadata:s:a:0 "language=$lang" \
    "${hls[@]}" -hls_segment_filename "$dir/audio/$lang/seg%03d.ts" "$dir/audio/$lang/index.m3u8"
done

# WebVTT cues are timed against the MPEG-TS clock of the first video segment.
start_pts=$(ffprobe -v error -select_streams v:0 -show_entries packet=pts -read_intervals "%+#1" -of default=nw=1:nk=1 "$dir/video/360p/seg000.ts" | head -n 1)
{
  printf 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:%s,LOCAL:00:00:00.000\n\n' "$start_pts"
  for ((t = 0; t < seconds; t += 10)); do
    printf '%02d:%02d:%02d.000 --> %02d:%02d:%02d.000\nExample subtitle at %d s\n\n' \
      $((t / 3600)) $((t / 60 % 60)) $((t % 60)) $(((t + 4) / 3600)) $(((t + 4) / 60 % 60)) $(((t + 4) % 60)) "$t"
  done
} > "$dir/subs/en/0.vtt"
printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%d\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:%d.000,\n0.vtt\n#EXT-X-ENDLIST\n' \
  "$seconds" "$seconds" > "$dir/subs/en/index.m3u8"

cat > "$dir/master.m3u8" <<'EOF'
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="tr",NAME="Türkçe",DEFAULT=NO,AUTOSELECT=YES,URI="audio/tr/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="subs/en/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
video/360p/index.m3u8
EOF
printf '{"title":"Demo","languages":{"audio":["en","tr"],"subtitles":["en"]}}\n' > "$dir/info.json"

ffmpeg -hide_banner -loglevel error -y -i "$dir/video/360p/index.m3u8" -i "$dir/audio/en/index.m3u8" \
  -map 0:v -map 1:a -c copy -movflags +faststart "$dir/video.mp4"

echo "media for the example upstream written to $dir ($(du -sh "$dir" | cut -f1))"
