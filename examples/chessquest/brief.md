# ChessQuest

A small web application that teaches the basics of chess to children aged 7–11.

This file is a **benchmark brief for Conjunction**, not a task for this
repository. It exists so the same request can be run through different
workflows and the results compared objectively. Conjunction does not generate
this application as part of its own test suite.

## Objective

Build a self-contained web application in which a child can learn how chess
pieces move, practise on an interactive board, and see their progress
remembered between visits.

The tone is playful but never patronising: short sentences, concrete
instructions, no walls of text. A child should be able to complete a lesson
without an adult reading the screen for them.

## Requirements

### Interactive chessboard

- An 8×8 board with correct coordinates (files a–h, ranks 1–8) and standard
  piece glyphs.
- Selecting a piece highlights its legal destination squares.
- Moves can be made by click-then-click and by keyboard alone.
- Illegal moves are refused with a short, kind explanation ("the bishop only
  moves diagonally") rather than silence.

### Three lessons

1. **How the rook moves** — straight lines, blocked by other pieces.
2. **How the bishop moves** — diagonals, and why a bishop never changes square
   colour.
3. **Capturing** — taking an opponent's piece, and why you cannot capture your
   own.

Each lesson has a goal position, a short explanation, at least three exercises,
and a completion state. A lesson can be replayed.

### Progress persistence

- Which lessons are complete and how many exercises were solved survives a page
  reload and a browser restart.
- Progress can be reset from the interface.
- A first-time visitor with no stored progress sees a sensible empty state, not
  an error or a blank screen.

### Accessibility

- Every interaction that works with a mouse also works with the keyboard alone,
  including moving pieces and navigating between lessons.
- Board squares and pieces are announced meaningfully to a screen reader
  ("e4, empty", "d5, white knight"), not as bare grid cells.
- Visible focus at all times; focus is never trapped or lost after a move.
- Colour is never the only carrier of meaning (legal squares, correct/incorrect
  answers).
- Text contrast meets WCAG 2.1 AA.

### Responsive UI

- Usable on a tablet in portrait and landscape, and on a desktop browser.
- The board stays square and fully visible without horizontal scrolling.
- Touch targets are comfortable for a child's finger.

## Constraints

- The chess rules engine must not live inside React components. Move generation
  and validation are pure functions, independent of any UI framework, and
  testable without rendering anything.
- Lessons must be extensible: adding a fourth lesson must not require editing
  the board engine or the rules engine.
- No backend, no server-side component. The application is fully static.
- No authentication, no accounts, no analytics, no third-party tracking.
- No network requests at runtime — everything needed ships with the app.
- Respect `prefers-reduced-motion`: no animation that a user has asked not to
  see.
- No external chess library — the point of the exercise is the modelling.

## Acceptance Criteria

- `typecheck` passes.
- `lint` passes.
- `test` passes, and the rules engine is covered by tests that run without a
  DOM.
- A new lesson can be added by adding a lesson definition only, without
  changing the board engine or the rules engine.
- Rook, bishop and capture rules are each covered by tests including blocked
  paths, board edges, and own-piece capture attempts.
- Progress survives a reload; resetting progress returns the app to the
  first-visit state.
- The full board can be operated with the keyboard alone, from selecting a
  piece to completing an exercise.
- No console errors or warnings on load or during a completed lesson.

## Out of scope

- Full chess: castling, en passant, promotion, check/checkmate detection.
- Playing a complete game, an AI opponent, or any multiplayer.
- Accounts, cloud sync, sound design, internationalisation.
