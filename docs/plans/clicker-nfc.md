# Future plan: tap-in games with NFC tags, a court-side station and a wrist remote

Status: **planned, not built.** Hardware: a tap-in station beside each court and a wrist remote for scoring (in design).

## The problem
At daily group sessions nobody wants to set up games on a phone: finding
players, picking sides, choosing a court. Any flow that needs an organiser
holding a phone fails. Players should create the game themselves with one
natural action, with phones left in their bags.

## The idea: tap in off the court, score from your wrist

![Concept: tap-in station beside the court, wrist remote for scoring](clicker-concept.png)

Two parts, so nothing sits at the net and nobody walks anywhere mid-game.

**1. Tap-in station: off the court, used only between games.**
On the side fence, the wall behind the court or the bench: outside the lines,
away from the net. One per court (or one shared station at the hall entrance,
with a court selector). It has two NFC pads, A and B, one per side, a small
display (court and score) and lights for who has tapped in.

- **Tap in.** On the way onto the court, each player taps their tag on their
  side's pad. When both sides are filled (1 v 1 or 2 v 2) the game starts.
- **No tag?** Press your side's pad without tapping: the spot is "open" and
  the player claims it later in the app with one tap. The game never waits.

**2. Scoring: a two-button wrist remote, one per court.**
A small Bluetooth remote (like a camera or presentation remote) in a silicone
wristband or clip, worn by any one player. Paired with that court's station.

- **Score.** Press A or B for the side that won the rally. A beep (and the
  station's display, or the venue TV) confirms it.
- **Undo.** Hold either button for 2 seconds.
- **End.** At the game's finishing score it's saved, the court is free, and
  the players get the result to confirm (as today).

### Why not on the net post
An earlier concept put one box with both pads on the net post. Two problems:
it's in the way during net play (players can hit it), and nobody walks to
the post after every rally. Tapping in happens once, so the station can live
off court; scoring happens every rally, so it has to stay on the player.

### Scoring alternatives
- **Smart end cap:** a tiny button plus the NFC tag in the racket's handle
  cap. The cap knows its owner and side, so a press scores for your side.
  Elegant but custom-made (about Rs 300–600 per cap), and the button must not
  be pressed by accident while playing.
- **Score at the end only:** no per-point scoring; when the game ends, enter
  the final score once on the station (two +/− dials). Same as the existing
  "final score" mode. Lowest effort when live scores don't matter.
- **Not recommended:** a phone listening for "point A" (halls are loud);
  pads on the net post (see above).

## Tags
- A player can link **any number of tags** (several rackets, paddles, a
  wristband). Any of them identifies the same person.
- **Link a tag:** in the app, "My tags → Add". On Android (Chrome Web NFC),
  hold the tag to the phone. On iPhone (no Web NFC), tap the tag on any
  court station within 30 seconds of pressing Add.
- **Unknown tag tapped:** joins the game as "Unknown player"; claimable later.
- **Borrowed racket:** the last tap on a side replaces an earlier one; or the
  tag's owner taps "Not me" on the result, which opens the spot to claim.
- **Lost tag:** "My tags" lists each (name, last used); remove it to disable.
- Each tag can also hold a link (NDEF URL) to the player's Tonament profile,
  so tapping it with any phone opens their page.

## App work (when the hardware is ready)
- Schema: `player_tags` (user, tag UID, label, created, last used, removed);
  stations bound to a group/venue court, wrist remotes paired to stations;
  open spots on games.
- API for the station: authenticated device token; events below.
- "My tags" page; tap-in games; claim / "Not me"; open spots.
- A **phone stand-in for the station and remote** (two big side pads; Web
  NFC on Android) so groups can trial the flow before the hardware exists.

## Station ↔ Tonament messages (draft)
The station authenticates with a per-device token and is bound to a court
(a shared station sends the court with each event). The wrist remote pairs
with the station over Bluetooth; its presses reach Tonament through it.
- `tag` `{ side: "a"|"b", uid: "04A1B2C3D4E5F6", at }` — a tag tapped on a side
- `press` `{ side, at }` — a point from the remote (or, at the station before
  the game starts, an "open spot" on that side)
- `undo` `{ at }` — take back the last point
- `reset` `{ at }` — clear a game that hasn't started
- `pair` `{ remote, at }` — a wrist remote paired with this station
- `court` `{ no }` — the court a shared station is set to
Server replies with the court's state (sides filled, score, game over) so
the station can light up and beep. Events carry a sequence number and are
queued on the device if the connection drops (same idea as offline scoring
today). Connection: open question — Wi-Fi, 4G, or Bluetooth to a phone.

## NFC tag facts (for choosing hardware)
- **Chip:** NTAG213/215 (NFC Forum Type 2). Read by every NFC phone,
  including iPhones; cheap; 144/504 bytes of storage. Avoid MIFARE Classic
  (many phones, including iPhones, can't read it; its security is broken).
- **Identity:** every tag has a factory-set, unchangeable 7-byte ID (UID). That
  is what Tonament stores. UIDs can be cloned with special blank tags; fine for
  casual games. If spoofing ever matters (prize leagues), NTAG 424 DNA tags
  produce a fresh signed code on every tap.
- **No battery.** Powered by the reader's field; lasts years; waterproof
  versions (epoxy, silicone) survive sweat.
- **Range:** a deliberate tap, about 1–4 cm. That is a feature here: it can't
  pick up the next court or someone walking past.
- **Metal and carbon:** frames and shafts can block the signal. Put the tag on
  the plastic butt cap of the handle, or use "anti-metal" (on-metal) tags.
- **Write/lock:** tags can store a URL and be write-locked.
- **Typical prices in India** (approximate, retail, 2026; check before buying):
  - NTAG213 stickers, round 25 mm: Rs 10–25 each in packs of 50–100
  - Anti-metal (on-metal) stickers: Rs 40–90
  - Epoxy coin / keyfob tags: Rs 30–60
  - Silicone wristbands: Rs 50–120
  - NTAG 424 DNA (secure): Rs 80–200
  - Reader modules for the station: RC522 Rs 100–200, PN532 Rs 300–450
    (two per station, one per side)
  - Wrist remote: off-the-shelf Bluetooth remote Rs 150–400, plus a
    silicone wristband or clip
- A starter kit for a 20-player group: 20 stickers plus a few spares, about
  Rs 300–600; about Rs 300–900 per station for the readers; Rs 150–400 per
  court for the wrist remote.
