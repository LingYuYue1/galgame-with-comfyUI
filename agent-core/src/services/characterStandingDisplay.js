import { createStandingDisplay } from './standingDisplayState.js';

/** Keep per-character turns alive when the independent display selects someone else. */
export function withCharacterStandingStates(global, options) {
  const characters = new Map();
  const turns = new WeakMap();
  function character(id) {
    id = Number(id);
    if (!characters.has(id)) characters.set(id, createStandingDisplay({ ...options, initialCharacter: id }));
    return characters.get(id);
  }
  return {
    ...global,
    characterSnapshot: id => character(id).snapshot(),
    begin(id, key) {
      const turn = global.begin(id, key);
      const scoped = character(id);
      turns.set(turn, { scoped, turn: scoped.begin(id, key) });
      return turn;
    },
    expression(turn, slot) {
      global.expression(turn, slot);
      const local = turns.get(turn);
      if (local) local.scoped.expression(local.turn, slot);
    },
    complete(turn) {
      global.complete(turn);
      const local = turns.get(turn);
      if (local) local.scoped.complete(local.turn);
    },
    reason(turn, text) {
      global.reason(turn, text);
      const local = turns.get(turn);
      if (local) local.scoped.reason(local.turn, text);
    },
    refresh() { global.refresh(); for (const local of characters.values()) local.refresh(); },
  };
}
