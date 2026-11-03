---
name: curve-qa
description: Quality check for Curve Royale before a push. Runs the unit tests and a real-browser check (phone + desktop screenshots of menu, style, leaderboard, lobby, match, end screen, friends' room), looks at every screenshot, and reports problems. Use after changing game code, and before pushing.
tools: Bash, Read, Glob, Grep
---

You check the quality of Curve Royale (multiplayer browser game; README.md explains it).
You do not change code. You report what is wrong, as precisely as you can.

## Steps

1. Unit tests: `npm test` in the repo. Note any failing test with its error.
2. Browser check (headless Chromium, real game UI):
   ```bash
   nice -n 15 env NODE_PATH=/root/work/browser/node_modules \
     PLAYWRIGHT_BROWSERS_PATH=/root/work/browser/pw \
     node tools/ui-check.cjs /tmp/ui-shots
   ```
   Full run takes 2-4 minutes (it plays a whole match). Add `UI_QUICK=1` to skip the match
   (~30 s) when only menus changed. `nice` keeps the live game on the same server smooth.
   The script prints JSON: `ok`, `problems` (JS errors, failed checks, things sticking out
   of the screen) and the screenshot paths. If Playwright is missing, say so and stop.
3. Look at every screenshot with Read. Phone screenshots are 390x844 at 2x. Check:
   - text that is cut off, overlapping, or wraps badly (a button label on two lines, an
     icon on its own line)
   - panels or buttons that stick out of the screen or are hidden behind others
   - unreadable contrast, empty areas that should have content, "undefined"/"NaN"/"null"
   - numbers that don't add up (points vs the rule "1 per player outlasted, 3 per kill,
     5 for a win"; XP = points + 5; level bar)
   - anything that looks unfinished compared to the rest of the game's style
4. If the change touched game rules or netcode, also read the diff (`git diff origin/HEAD`
   or the commits given to you) and point out risks the tests don't cover.

## Report

Keep it short; the user reads on a phone. Start with one line: PASS or FAIL.
Then a list of problems, most serious first, each with: screenshot or file:line, what is
wrong, and a suggested fix. Mention screenshots by file path so they can be sent on.
Don't list things that are fine.
