# LLM Leaders — AI-driven diplomacy for Civilization VI

[Русская версия](README.ru.md)

A mod for **Sid Meier's Civilization VI: Gathering Storm** that hands the AI leaders' diplomacy to a large language model.
You talk to leaders in free text, they answer in character, propose real deals and treaties, negotiate with each other,
form alliances and blocs, keep (or break) their promises — and you watch it all in an in-game chronicle.

Works with any OpenAI-compatible API (OpenAI, DeepSeek, OpenRouter, Groq, Ollama, LM Studio…) and with Anthropic Claude.

> **Languages.** The in-game window is available in **English and Russian**: it follows the game's language and can be forced
> with `ui_language`. Leaders reply, and write treaty titles and chronicle summaries, in whatever language you set in `language`.

---

## Features

**Talk to leaders**
- An «ИИ-дипломатия» (AI diplomacy) window in the game: free-text chat with every leader you have met.
- Every reply is generated in character (personas are plain text in `bridge/personas.yaml`, hot-reloaded).
- Short, to-the-point replies by default; full monologues with `reply_style: normal`.
- Leaders remember the conversation, promises and grudges (per-save memory) and write to you first now and then.
- The chat history is restored after loading a save.

**Real deals** — a deal card with *Accept / Decline*; on accept the game state actually changes:

| Item | How it is executed |
|---|---|
| Gold (one-time or per turn) | treasury change, per-turn payments tracked by the bridge |
| Strategic resources | stockpile transfer |
| Luxury resources (30 turns) | the game's own deal system |
| Open borders (30 turns) | the game's own deal system |
| Diplomatic favor | favor transfer |
| Military units (up to 5 per item) | unit recreated in the receiver's capital (ships in a coastal city), damage kept |
| Nuclear warheads | WMD stock transfer |
| Peace | ends the war |

Impossible offers are caught by a validator and the leader is asked to rephrase, so the words always match the card.

**Treaties and blocs** (with you and between AI leaders)
- Memorandum, trade agreement, non-aggression pact, mutual defense pact, declaration of friendship
  (real in-game friendship), alliance (real in-game alliance), founding/joining a bloc, joint war, peace treaty.
- Your active treaties with a leader are shown under their name in the chat.
- Terminate a treaty just by telling the leader so; leaders may terminate treaties with you too.

**World diplomacy** — the AI leaders talk to each other
- Every turn a pair of leaders holds closed negotiations (2–3 rounds, counter-offers included) and may sign documents,
  trade resources, gold or units.
- **World Chronicle** (in the chat window): a one-line summary per speaker — who offers what and what they expect — and the outcome.
- **Treaties & Blocs**: a registry of active, broken, terminated and expired agreements.
- Consequences:
  - **Perfidy**: attacking a treaty partner breaks the treaty, and the attacker is expelled from shared blocs.
  - **Allied duty**: defense partners decide whether to join a war.
  - **Allies dragged in**: allies pulled into a war by the game itself are handled correctly.

**Grounded in the actual game state**
- Every prompt includes a "balance of power" section: army strength ratio, nuclear arsenals, carriers/bombers/fighters,
  treasury, and the leader's military units.
- Leaders are told to rely only on game data (not real-world knowledge) and to react rationally to real threats.
- Nuclear strikes are detected (`Events.WMDDetonated`): the victim responds, the world condemns, allies react.

**Strategy layer** — every few turns each leader makes big decisions: war, peace, opinions, and planned negotiations.

---

## How it works

```
Civilization VI + mod (chat window, event queue, state snapshot)
        ⇅  FireTuner protocol, TCP 127.0.0.1:4318
Node.js bridge (prompts, validation, deals, treaties, memory)
        ⇅  HTTPS
LLM API (OpenAI-compatible or Claude)
```

- Civ VI's Lua sandbox has no network or file access, so an external **bridge** talks to the game through the
  **FireTuner** debug protocol.
- **Game → bridge.** The mod queues events. The bridge polls them and reads state snapshots as hex-encoded JSON packets.
- **Bridge → game.** The bridge sends Lua calls with byte-escaped strings, which keeps Cyrillic safe.
- **Where things run.** Gameplay changes (gold, resources, war/peace, units, friendship/alliance) run in the `GameCore_Tuner`
  context. Native deals (luxury, open borders) run in the mod's UI context.
- **Division of labour.** The game's standard AI still controls tactics (armies, building). The LLM controls diplomacy,
  and conversations shift the standard AI's opinion (`AdjustBaseDiplomacy`).

---

## Requirements

- Windows, Civilization VI with the **Gathering Storm** expansion
- [Node.js](https://nodejs.org) 18+
- An LLM API key (or a local model via Ollama / LM Studio)
- **FireTuner must be enabled** — this **disables achievements** for that game

## Installation

1. Clone the repository anywhere.
2. Launch Civilization VI once and close it, so the game creates its settings files.
3. Run `install.bat`. It:
   - links `mod/LLMLeaders` into `Documents\My Games\Sid Meier's Civilization VI\Mods` (a junction);
   - sets `EnableTuner 1` in `AppOptions.txt`, keeping a `.bak` copy. If that fails, enable it in the game:
     *Options → Game → Tuner*;
   - installs the bridge dependencies and creates `bridge/config.yaml`.
4. Open `bridge/config.yaml` and set the provider, `base_url`, `api_key` and `model`.

## Running

1. Start Civilization VI, enable **LLM Leaders** in *Additional Content*, start or load a game.
2. Optional: run `probe.bat` to check the connection. It writes a report to `bridge/probe-report.txt`.
3. Run `start.bat` and keep the bridge window open while playing.
4. In the game, click **«ИИ-дипломатия»** at the top of the screen.

Only one program can be connected to FireTuner at a time, so close the official FireTuner app.

---

## Configuration (`bridge/config.yaml`)

| Section | Key | Meaning |
|---|---|---|
| `llm` | `provider` | `openai` (any OpenAI-compatible API) or `anthropic` |
| | `base_url`, `api_key`, `model` | endpoint, key (or env `LLM_API_KEY`), model |
| | `background_model` | cheaper model for the strategy layer (empty = same) |
| | `json_mode` | use `response_format: json_object` |
| | `extra_body` | extra request fields, e.g. DeepSeek: `thinking: { type: disabled }` |
| | `language` | language of the leaders' replies and LLM-written texts, e.g. `English` (top-level key) |
| | `ui_language` | mod window language: `auto` (from `language`), `en`, `ru` (top-level key) |
| `behavior` | `reply_style` | `short` (one sentence) or `normal` |
| | `proactive_every_turns`, `proactive_chance` | how often leaders write first |
| | `sync_native_opinion` | conversations change the standard AI's opinion |
| | `allow_war_on_player` | leaders may declare war on you |
| | `allow_unmet` | show leaders you haven't met (testing) |
| `strategy` | `enabled`, `every_turns`, `allow_ai_wars` | the strategy layer |
| `world` | `enabled`, `every_turns`, `negotiations_per_turn` | AI-to-AI negotiations (≈3 LLM calls each) |
| | `max_rounds` | 2 = offer + answer, 3 = with counter-offer |
| | `defense_calls_per_turn`, `allow_joint_war` | allied duty / joint wars |
| | `chronicle_style` | `summary` (one line per speaker) or `full` (verbatim) |
| `limits` | `max_calls_per_turn`, `history_messages` | cost control |

Example for DeepSeek:

```yaml
llm:
  provider: openai
  base_url: https://api.deepseek.com/v1
  api_key: "sk-..."
  model: deepseek-flash
  json_mode: true
  extra_body:
    thinking: { type: disabled }
```

**Cost.** With a small, cheap model a game costs cents: one negotiation is ~3 requests of ~3k tokens.
Use `limits`, `world.every_turns` and `strategy.every_turns` to tune it.

---

## Personas (`bridge/personas.yaml`)

Describe each leader in plain text — character, manner of speech, values, what they want in trade, when they go to war.
The key is a leader type (`LEADER_...`), a civilization type (`CIVILIZATION_...`) or the leader's in-game name.

```yaml
leaders:
  LEADER_GORGO: >
    Laconic and sharp-tongued, values courage above wealth...

  # optional: a custom name and country shown in the chat and to other leaders
  LEADER_TRAJAN:
    name: Marcus the Merchant
    civ: Republic of Rome
    persona: >
      A cynical trader who will sell an ally for 50 gold.
```

The file is reloaded automatically — you can change a leader's personality mid-game.

---

## Project layout

```
mod/LLMLeaders/          the Civ VI mod (UI context: chat window, events, snapshots)
  UI/LLMLeaders.lua      window logic, bridge API (LLM_Poll / LLM_Deliver / LLM_Snapshot), event hooks
  UI/LLMLeaders.xml      window layout
  UI/LLMJson.lua         JSON + hex packet encoder
bridge/                  Node.js bridge
  src/main.js            entry point: connect, poll loop, event routing
  src/tuner.js           FireTuner protocol client
  src/game.js            game actions and queries (gold, resources, units, deals, war/peace, alliances)
  src/brain.js           leader prompts, chat, deals, strategy layer
  src/diplomacy.js       AI-to-AI negotiations, treaties, blocs, chronicle, perfidy and allied duty
  src/llm.js             OpenAI-compatible and Anthropic clients
  src/memory.js          per-save memory (bridge/data/<gameId>.json)
  probe.js               connection self-test
  dev/lua.js             dev tool: run Lua in a live game state (stop the bridge first)
install.bat / install.ps1, start.bat, probe.bat
```

## Limitations and notes

- **Debug interface.** The mod uses the FireTuner debug interface and debug-level game functions, so achievements are off.
- **Native deals need you.** Luxury resources and open borders go through the game's own deal system. That only works
  when the human player is one of the parties, so AI-to-AI deals use gold, strategic resources, favor and units.
- **Alliances.** A real in-game alliance cannot be ended early (a Civ VI rule); it expires on its own after its term.
  Terminating the alliance treaty in the mod removes all mod-side obligations right away.
- **Language and testing.**
  - The UI is English and Russian.
  - The prompts sent to the LLM and the bridge console log are written in Russian internally. Models handle this fine;
    translating them is a welcome contribution.
  - The bridge was tested with DeepSeek (`deepseek-flash`). Other models should work but may follow the JSON format
    less strictly.

## Contributing

Contributions are welcome — bug reports, personas, translations (UI: English and Russian so far), prompt tuning,
new deal types, UI polish. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and guidelines.

## License

[MIT](LICENSE) — free to use, modify and distribute, including commercially; just keep the copyright notice.

Not affiliated with Firaxis Games or 2K. Civilization is a trademark of Take-Two Interactive.
