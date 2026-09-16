/**
 * The set of nodes you have picked, and turning one into a saved view.
 *
 * The galaxy knows which meshes are selected — it does the hit testing — but it
 * has no reason to know that a selection can be named and kept. That lives
 * here, along with the shape a node-set preset takes, so the presets in the HUD
 * and the `?preset=` link both go through one place.
 */

// A preset is either a set of filters or a set of nodes. They are stored
// together and told apart by this field, so an old saved view still loads.
export function nodeSetPreset(ids, view) {
  return { nodes: [...ids], view };
}

export function isNodeSet(preset) {
  return Array.isArray(preset?.nodes);
}

export function createSelection(galaxy) {
  let ids = [];
  const listeners = new Set();

  galaxy.onSelectionChange((nodes) => {
    ids = nodes.map((node) => node.id);
    for (const listener of listeners) listener(ids);
  });

  return {
    ids: () => ids,
    count: () => ids.length,
    onChange(listener) {
      listeners.add(listener);
      listener(ids);
    },

    /** The current selection, ready to be stored under a name. */
    asPreset(view) {
      return nodeSetPreset(ids, view);
    },

    /**
     * Render a saved node set: those nodes stay, the rest leave. Ids that no
     * longer exist are dropped rather than emptying the galaxy — a set saved
     * last month should survive a note being deleted since.
     */
    apply(preset, knownIds) {
      const wanted = new Set(preset.nodes.filter((id) => knownIds.has(id)));
      galaxy.setOnly(wanted.size ? wanted : null);
      return wanted;
    },

    clear() {
      galaxy.setOnly(null);
    },
  };
}
