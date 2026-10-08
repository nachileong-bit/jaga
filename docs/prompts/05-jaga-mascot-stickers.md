# Prompt 05: Jaga mascot stickers and emojis

You are working in the Jaga repo. Read README.md, src/conversation/flow.ts, src/conversation/types.ts, src/copy/en.ts, src/channels/waha.ts and web/app.js first.

## Goal
Give Jaga a friendly personality with its owl mascot. Jaga sends a sticker at key moments and uses a few emojis, in both the web demo and WhatsApp. Safety copy stays plain.

## Assets
Sticker PNGs are in `web/stickers/` (transparent, 512x512):
01-hello.png, 02-still-got.png, 03-counting.png, 04-day-14.png, 05-see-gp.png, 06-booked.png, 07-went-already.png, 08-better.png.
Mascot image: `web/brand/jaga.png`.

## Changes
1. `src/conversation/types.ts`: add optional `sticker?: string` to `TranscriptEntry` (a file name from web/stickers).
2. `src/conversation/flow.ts`: add a private `sticker(name)` helper that pushes a jaga entry with empty text and `sticker` set. Send stickers at exactly these moments, AFTER the text message of that moment:
   - greeting at the start: 01-hello.png
   - clock started (after the warning-sign questions): 03-counting.png
   - each check-in question ("Still coughing?"): 02-still-got.png
   - the policy rule is reached (the "long enough that it should be checked" message): 04-day-14.png, then after the "Why I'm saying this" message: 05-see-gp.png
   - appointment booked: 06-booked.png
   - "Did you manage to see the doctor?": 07-went-already.png
   - trajectory "better" or "gone" reported: 08-better.png
   NEVER send a sticker with a warning-sign (red flag) message, a 995 message, the "I don't know" answer, or the "I can't tell you what is causing it" answer. Those stay plain text.
3. `src/copy/en.ts`: add light emojis, at most one per message, never in red-flag, 995, abstention or diagnosis-refusal copy:
   - GREETING ends with " 🦉"
   - CLOCK_STARTED: start with "⏱️ "
   - check-in question: start with "👋 "
   - booking confirmed: start with "✅ "
   - "Did you manage to see the doctor?": start with "🩺 "
   Keep the existing no em dash rule.
4. `web/app.js` + `web/style.css`: render a sticker entry as a 140px image with no bubble background, left-aligned like a Jaga message. Header avatar: use web/brand/jaga.png as a round 36px avatar next to "Jaga".
5. `src/channels/waha.ts`: add `sendImage(chatId, url)` to the Sender interface. WahaSender calls WAHA `POST /api/sendImage` with `{ session, chatId, file: { url, mimetype: "image/png" } }`. The bridge sends sticker entries as images using `publicBaseUrl + "/web/stickers/" + name`. If publicBaseUrl is missing, skip stickers on WhatsApp. Update the fake sender in tests.
6. Tests (vitest):
   - the Mr Tan journey to day 14 includes stickers 01, 03, 02, 04, 05 and 06 in that order
   - no sticker entry follows a red-flag message, the KB_NO_ANSWER message or the KB_NO_DIAGNOSIS message
   - red-flag copy, KB_NO_ANSWER and KB_NO_DIAGNOSIS contain no emoji
   - the WhatsApp bridge sends a sticker as an image and skips it when publicBaseUrl is not set
7. Run `npm test` and `npm run timelines`. All must pass. Do not change any rule, threshold or policy file.
