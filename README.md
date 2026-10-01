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

## Set up on the Linux Mint laptop

1. Copy both folders to the laptop so they sit side by side, for example `~/Schedule_Website` and `~/Schedule_App`.
2. Run:
   ```bash
   bash ~/Schedule_Website/setup.sh
   ```
   This installs ffmpeg, sqlite3 and Node 22, starts Schedule as a service that runs on boot, keeps the laptop awake with the lid shut, sets up nightly backups, and connects Tailscale.
3. Install Tailscale on your phone with the same account. Open `https://<laptop-name>.<tailnet>.ts.net/app/` in Safari → Share → **Add to Home Screen**. The website is the same link without `/app/`.

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

The server only listens on the laptop itself, and Tailscale is the only way in, so there's no login. Don't forward a port on your router.

## API (used by both the app and the website)

| Method | Path | Does |
|---|---|---|
| GET | `/api/state` | current activity, places, activities |
| POST | `/api/places` `{name}` · DELETE `/api/places/:id` | add / remove a place |
| POST | `/api/tags` `{name}` · DELETE `/api/tags/:id` | add / remove an activity |
| POST | `/api/switch` `{tag_id, place_id}` | start a new activity now |
| POST | `/api/entries/:id/media` `{media_id}` | attach a meme to a switch |
| DELETE | `/api/entries/:id` | delete a switch |
| GET | `/api/entries?from=&to=` | switches in a time range (with end times) |
| GET | `/api/media?tag_id=` | memes, that activity's first |
| POST | `/api/media` (form: `file`, `tag_id`) | upload a picture, GIF or video (saved square) |
| POST | `/api/rescan` | re-read the memes folder |
