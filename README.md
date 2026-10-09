# Fit the Line

A classroom game for practicing regression by eye. Students drag two handles to place a trendline over a scatter plot, then press **Check** to reveal the least-squares regression line, the gap between the two lines, and a score.

## How it plays

- 10 rounds per game, with a new random scatter plot each round (rising or falling trend).
- Title screen with three choices: Play solo, Join a class (students), and Launch a class game (teacher). Arrow keys and Enter work on the menu.
- Class mode: anyone can launch a class (no login), pick a difficulty and round count, and gets a 4-letter code for the board. Students enter the code and a name (no login). Everyone sees the same dots each round, the teacher reveals the answer, and a live scoreboard, final podium and CSV download follow.
- Retro arcade look: pixel fonts, a CRT-style plot screen, and a HUD with round, total and hi-score. Fonts load from Google Fonts.
- On Next Round, every dot glides to its new spot after its own short random delay. Check Line is held until they land, and reduced-motion settings skip the animation.
- Three difficulty levels. Easy is the tightest scatter, Medium is looser, and Hard is the loosest and adds two stray points that pull the true line toward them.
- Score per round is 0 to 100, based on the average vertical gap between the student's line and the least-squares line.
- After checking, the page shows both equations, the SSE (sum of squared residuals) for each line, and r. A menu draws the residuals for either line.
- Handles work with mouse, touch, or the arrow keys (Shift for bigger steps).
- Best average per difficulty is saved in the browser's localStorage.

## Class mode setup (one time)

Class mode uses Firebase (free Spark plan). The config is already in `firebase-backend.js`. In the Firebase console for the `trendlinegame` project:

1. Build > Firestore Database: create the database (production mode).
2. Build > Authentication > Sign-in method: enable **Anonymous** (students and teachers).
3. Paste `firestore.rules` into Firestore > Rules and Publish.
4. Optional: Firestore > TTL, add a policy on field `expiresAt` for collection group `classes` so old classes clean up.

If the class server cannot be reached, the page shows a "practice mode" banner and keeps classes in the browser's storage, so a teacher tab and student tabs on one device can rehearse.

## Running it

It is a static site with no build step. Solo play needs only `index.html`; class mode also loads `firebase-backend.js` and the Firebase SDK from gstatic. Open `index.html` in a browser, or serve the repo with GitHub Pages (Settings > Pages > deploy from the `main` branch, root folder).
