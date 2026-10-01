# Filming Schedule

A calendar for supporting-artist availability checks. It runs in any browser on your PC or phone.

- **Calendar:** month and agenda views, coloured by status. A clash is flagged when a confirmed booking overlaps another call.
- **Calls:** search and filter, with one-tap **Accept / Decline**, then **Booked / Released**.
- **Stats:** calls per week and per month, by agency and by role, plus your accept rate and days on set.
- **Automatic email reading:** a GitHub robot checks your Yahoo inboxes every 30 minutes and adds new availability checks.
- **Paste an email:** you can also paste one into the app by hand.

**Set-up guide: [SETUP.md](SETUP.md)**

## Files

| File | What it is |
|---|---|
| `index.html` | The app |
| `parser.js` | Reads an agency email and finds the production, agency, role, dates and locations |
| `firebase-config.js` | Which Firebase database the app uses |
| `firestore.rules` | Who may open the database (only you) |
| `scripts/check-email.js` | The robot that reads Yahoo |
| `.github/workflows/check-email.yml` | Runs the robot every 30 minutes |
| `tests/` | Example emails and a test that checks `parser.js` (`npm test`) |
