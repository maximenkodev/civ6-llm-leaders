# Contributing to LLM Leaders

Thanks for your interest! Contributions of all kinds are welcome — bug reports, new personas, translations,
prompt improvements, new deal types, UI polish and documentation.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE) of this project.

## Ways to help

- **Report a bug.** Open an issue with:
  - what you did and what you expected;
  - the relevant lines from the bridge window (or `bridge/bridge-live.log` if you redirect output);
  - a screenshot for UI problems.

  Remove your API key from anything you paste.
- **Suggest a feature.** Open an issue describing the gameplay you want. Diplomacy ideas are welcome: new treaty
  types, events leaders should react to, better negotiation logic.
- **Share personas.** Good leader descriptions make the mod. Send a PR that adds entries to `bridge/personas.yaml`.
  Keep them about the leaders as game characters.
- **Translate.** The UI strings live in `mod/LLMLeaders/UI/LLMLeaders.lua`, and the prompts live in `bridge/src/brain.js`
  and `bridge/src/diplomacy.js`. Both are currently Russian. An English or other-language UI is a great contribution.
- **Code.** Fix bugs, add deal types, improve the UI layout, add tests.

## Development setup

1. Windows + Civilization VI with Gathering Storm, Node.js 18+.
2. Fork and clone the repo, then run `install.bat`. It links the mod into the game's `Mods` folder with a junction,
   so edits to `mod/` are picked up when you load a save.
3. Put your provider settings into `bridge/config.yaml`. This file is git-ignored. **Never commit API keys.**
4. Start the game with the mod enabled, then run `probe.bat` (connection self-test) and `start.bat`.

What needs a reload after a change:

| You changed | What to do |
|---|---|
| `mod/LLMLeaders/UI/*` | reload the save, or return to the menu and load again |
| `bridge/src/*` | restart the bridge |
| `bridge/personas.yaml` | nothing — it hot-reloads |

### Useful tools

- `node bridge/probe.js` — checks the FireTuner connection, the mod, Cyrillic round-trips, game API availability.
- `node bridge/dev/lua.js <State> "<lua>"` — runs Lua in a live game state, for example
  `node bridge/dev/lua.js GameCore_Tuner "print(Game.GetCurrentGameTurn())"`. Stop the bridge first:
  only one FireTuner connection is allowed.

## Code guidelines

- **Execution contexts.** Gameplay changes go through `bridge/src/game.js`, which runs Lua in `GameCore_Tuner`.
  UI-only things run in the mod's `LLMLeaders` context.
- **Verify game functions live.** Not every game function exists in every Lua context. Check with `dev/lua.js`
  before relying on one, and prefer functions you have seen in the game's own scripts or debug panels.
- **Cyrillic and other non-ASCII text:**
  - In XML `String=""` attributes it doesn't render, so set texts from Lua.
  - Never use `%c`/`%s`/`%a` Lua patterns. They are locale-dependent in the game and corrupt UTF-8.
  - Use `[NEWLINE]` instead of `\n` in labels. The mod's `UIText()` does this.
- **Keep tuner commands small.** Use `GameLink.deliverChunked` for lists; flooding the game with commands can freeze it.
- **Validate before executing.** Every LLM-proposed deal or treaty must pass validation (`validateItem`,
  `WorldDiplomacy.validate`) before it touches the game state.
- **Prompts ask for strict JSON.** If you add a field, document it in the prompt and handle its absence gracefully.
- **Style:** plain ES modules, no build step, small focused functions. Comments in English or Russian are both fine.

## Pull requests

1. Create a branch from `main`.
2. Keep each PR focused on one feature or fix, and describe what changed and how you tested it in the game.
3. Run `node --check` on changed JS files; for UI changes attach a screenshot.
4. Make sure no secrets or personal data (`bridge/config.yaml`, `bridge/data/`, logs) are included.

## Code of conduct

Be respectful and constructive. Critique ideas, not people.
