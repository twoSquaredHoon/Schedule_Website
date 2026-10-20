# Schedule — website + server

Screen time for your life. You switch activities on your phone, and this server keeps the log.

- **Schedule_Website** (this folder): the server, the database code, and the website (Timeline, Stats, Memes).
- **Schedule_App** (next to it): the phone app (Home, Switch, Meme pick). The server hosts it at `/app/`.
- **Data** lives outside the code in `~/schedule-data` on the laptop:
  - `schedule.db` — places, activities, memes, every switch
  - `memes/` — your memes. One sub-folder per activity (`memes/Study/`, `memes/Gym/`…). Loose files at the top have no activity.
  - `memes/.originals/` — original videos after they were turned into square GIFs
  - `backups/` — nightly copies of the database

Places and activities start empty. You add them in the phone app (round **+**), and they show up on the website straight away because both read the same database. Adding an activity also creates its folder in `memes/`.

Renaming (pencil button in the app) changes the name everywhere, past entries included; renaming an activity also renames its `memes/` folder. Deleting only hides it from the app: past entries, stats and its memes keep it, and adding the same name again brings it back.

## Set up on the Linux Mint laptop

1. Copy both folders to the laptop so they sit side by side, for example `~/Schedule_Website` and `~/Schedule_App`.
2. Run:
   ```bash
   bash ~/Schedule_Website/setup.sh
   ```
   This installs ffmpeg, sqlite3 and Node 22, starts Schedule as a service that runs on boot, keeps the laptop awake with the lid shut, sets up nightly backups, and connects Tailscale.
3. Install Tailscale on your phone with the same account. Open `https://<laptop-name>.<tailnet>.ts.net/app/` in Safari → Share → **Add to Home Screen**. The website is the same link without `/app/`.

## Location + notifications (iPhone)

How it works: **OwnTracks** (free iPhone app) sends your location to this server in the background. When you're inside a pinned place, the server guesses the activity from what you've logged there at that time of day, saves a suggestion that starts at your arrival time, and sends a notification. Confirming it in the app logs it from the arrival time. If one activity runs longer than 3 hours (not Sleep, not 11pm–8am), you get a "Still …?" reminder.

1. **Notifications** — open Schedule from your home screen (not in Safari), tap the **bell** on Home, Allow. You should get "Notifications work" right away. Needs iOS 16.4 or newer.
2. **Pin your places** — in the app: Switch → pencil next to the places' **+** → tap a place → tap the **map pin** while you're there. Default radius is 120 m.
3. **Tailscale always on** — Tailscale app → turn on **VPN On Demand**, so the phone can always reach the laptop.
4. **OwnTracks** — install from the App Store, then in its settings:
   - **Mode:** HTTP
   - **URL:** `https://<laptop-name>.<tailnet>.ts.net/api/owntracks`
   - iPhone Settings → OwnTracks → Location: **Always**, Precise Location **on**
   - Monitoring (the icon at the top of the map): **Significant changes** saves battery and updates every few hundred meters; **Move** is more exact but uses more battery.

Locations are stored only on the laptop (`locations` table). Change the reminder with `Environment=NUDGE_HOURS=3` in the service file.

## Bring in your memes

From your Mac (with Tailscale on):
```bash
scp -r ~/Desktop/"untitled folder"/* <user>@<laptop-name>:~/schedule-data/memes/
```
The server checks the folder every 5 minutes. To check right away: `curl -X POST http://127.0.0.1:3000/api/rescan` on the laptop. Sub-folder names become activities, and any videos are turned into square GIFs.

## Everyday commands (on the laptop)

```bash
systemctl status schedule          # is it running?
journalctl -u schedule -f          # live log
sudo systemctl restart schedule    # after copying in new code
```

## Settings

Set in `/etc/systemd/system/schedule.service`:

| Variable | Default | What it is |
|---|---|---|
| `PORT` | `3000` | Port the server listens on (only on the laptop itself, 127.0.0.1) |
| `SCHEDULE_DATA` | `~/schedule-data` | Where the database and memes live |
| `SCHEDULE_APP_DIR` | `../Schedule_App` | Where the phone app files are |
| `NUDGE_HOURS` | `3` | Remind you after one activity runs this long |

The server only listens on the laptop itself, and Tailscale is the only way in, so there's no login. Don't forward a port on your router.

## API (used by both the app and the website)

| Method | Path | Does |
|---|---|---|
| GET | `/api/state` | current activity, places, activities |
| POST | `/api/places` `{name}` · PATCH `/api/places/:id` `{name}` · DELETE `/api/places/:id` | add / rename / delete a place |
| POST | `/api/tags` `{name}` · PATCH `/api/tags/:id` `{name}` · DELETE `/api/tags/:id` | add / rename / delete an activity (rename also renames its memes folder) |
| POST | `/api/switch` `{tag_id, place_id}` | start a new activity now |
| POST | `/api/entries/:id/media` `{media_id}` | attach a meme to a switch |
| DELETE | `/api/entries/:id` | delete a switch |
| GET | `/api/entries?from=&to=` | switches in a time range (with end times) |
| GET | `/api/media?tag_id=` | memes, that activity's first |
| POST | `/api/media` (form: `file`, `tag_id`) | upload a picture, GIF or video (saved square) |
| POST | `/api/rescan` | re-read the memes folder |
| PUT | `/api/places/:id/location` `{lat, lng, radius?}` or `{clear:true}` | pin a place on the map |
| POST | `/api/owntracks` | location from the OwnTracks app |
| POST | `/api/location` `{lat, lng, acc?}` | location from anything else (e.g. iOS Shortcuts) |
| GET | `/api/suggestion` · POST `/api/suggestion/:id/accept` `{tag_id, place_id}` · `/dismiss` | the latest arrival suggestion; accepting logs it from the arrival time |
| GET | `/api/push/key` · POST `/api/push/subscribe` · POST `/api/push/test` | notifications |
