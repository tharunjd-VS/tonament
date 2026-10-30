# Future plan: tap-in games with NFC tags and the court clicker

Status: **planned, not built.** Builds on the court clicker (hardware, in design).

## The problem
At daily group sessions nobody wants to set up games on a phone: finding
players, picking sides, choosing a court. Any flow that needs an organiser
holding a phone fails. Players should create the game themselves with one
natural action, with phones left in their bags.

## The idea
Each player carries an NFC tag (on a racket or paddle, a wristband, a keyfob,
or their phone case). The court clicker has two pads, one per side, which are
also the scoring buttons, with an NFC reader under each.

1. **Tap in.** Before a game, each player taps their tag on their side's pad.
   When both sides are filled (1 v 1 or 2 v 2) the game starts on that court.
2. **Score.** The same pads, pressed: a point to that side. Hold to undo.
3. **End.** At the game's finishing score it is saved, the court is free, and
   the players get the result to confirm (as today).
4. **No tag?** Press your side's pad without tapping: the spot is "open" and
   the player claims it later in the app with one tap. The game never waits.

## Tags
- A player can link **any number of tags** (several rackets, paddles, a
  wristband). Any of them identifies the same person.
- **Link a tag:** in the app, "My tags → Add". On Android (Chrome Web NFC),
  hold the tag to the phone. On iPhone (no Web NFC), tap the tag on any
  court clicker within 30 seconds of pressing Add.
- **Unknown tag tapped:** joins the game as "Unknown player"; claimable later.
- **Borrowed racket:** the last tap on a side replaces an earlier one; or the
  tag's owner taps "Not me" on the result, which opens the spot to claim.
- **Lost tag:** "My tags" lists each (name, last used); remove it to disable.
- Each tag can also hold a link (NDEF URL) to the player's Tonament profile,
  so tapping it with any phone opens their page.

## App work (when the clicker is ready)
- Schema: `player_tags` (user, tag UID, label, created, last used, removed);
  clicker devices bound to a group/venue court; open spots on games.
- API for the clicker: authenticated device token; events below.
- "My tags" page; tap-in games; claim / "Not me"; open spots.
- A **phone stand-in for the clicker** (two big side pads; Web NFC on Android)
  so groups can trial the flow before the hardware exists.

## Clicker ↔ Tonament messages (draft)
Device authenticates with a per-device token, bound to a court.
- `tag` `{ side: "a"|"b", uid: "04A1B2C3D4E5F6", at }` — a tag tapped on a side
- `press` `{ side, at }` — a point (or "open spot" before the game starts)
- `undo` `{ at }` — take back the last point
- `reset` `{ at }` — clear a game that hasn't started
Server replies with the court's state (sides filled, score, game over) so
the clicker can light/beep. Events carry a sequence number and are queued on
the device if the connection drops (same idea as offline scoring today).
Connection: open question — Bluetooth to a phone at the court, Wi-Fi, or 4G.

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
  - Reader modules for the clicker: RC522 Rs 100–200, PN532 Rs 300–450
    (two per clicker, one per side, or one centre reader + side buttons)
- A starter kit for a 20-player group: 20 stickers plus a few spares, about
  Rs 300–600; about Rs 300–900 extra per clicker for the readers.
