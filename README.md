# Fit the Line

A classroom game for practicing regression by eye. Students drag two handles to place a trendline over a scatter plot, then press **Check** to reveal the least-squares regression line, the gap between the two lines, and a score.

## How it plays

- 10 rounds per game, with a new random scatter plot each round (rising or falling trend).
- Three difficulty levels. Easy is the tightest scatter, Medium is looser, and Hard is the loosest and adds two stray points that pull the true line toward them.
- Score per round is 0 to 100, based on the average vertical gap between the student's line and the least-squares line.
- After checking, the page shows both equations, the SSE (sum of squared residuals) for each line, and r. A menu draws the residuals for either line.
- Handles work with mouse, touch, or the arrow keys (Shift for bigger steps).
- Best average per difficulty is saved in the browser's localStorage.

## Running it

It is a single static file with no build step and no dependencies other than Google Fonts. Open `index.html` in a browser, or serve the repo with GitHub Pages (Settings > Pages > deploy from the `main` branch, root folder).
