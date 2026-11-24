/**
 * range-load.js — load a date range of the register instead of all of it.
 *
 * Shared by the dashboard, reports and heatmaps. Each page opens on a short
 * default range; widening the From/To dates and pressing Apply loads the wider
 * range ("load older"). Before loading anything other than the default, the
 * range is COUNTED (one read per 1,000 records) and, when it is large, the
 * user is told what it will cost and asked to confirm — the daily read quota is
 * shared with live capture.
 */

import { confirmDialog } from "./app.js";

/** Ranges above this many records ask before loading. */
export const LARGE_LOAD = 5000;

/** "YYYY-MM-DD" for `n` days ago — the same UTC date form the capture form stores. */
export const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/**
 * @param {object} o
 * @param {string} o.defaultFrom  the page's default From date (no count needed)
 * @param {(from: string, to: string) => Promise<number>} o.count
 * @param {(from: string, to: string) => Promise<void>} o.load
 * @param {string} [o.fromId] @param {string} [o.toId]  date input ids
 */
export function rangeLoader({ defaultFrom, count, load, fromId = "fFrom", toId = "fTo" }) {
  let loaded = null;
  return {
    get loaded() { return loaded; },
    /**
     * Load the range in the From/To inputs if it differs from what is loaded.
     * @param {{reload?: boolean}} [opts] reload:true re-reads an unchanged range
     * @returns {Promise<boolean>} false when the user declined a large range
     */
    async ensure({ reload = false } = {}) {
      const fromEl = document.getElementById(fromId), toEl = document.getElementById(toId);
      const from = fromEl.value, to = toEl.value;
      const changed = !loaded || loaded.from !== from || loaded.to !== to;
      if (!changed && !reload) return true;

      if (changed && !(from === defaultFrom && !to)) {
        const n = await count(from, to);
        if (n > LARGE_LOAD) {
          const ok = await confirmDialog({
            title: "Load a large range?",
            body: `This range holds ${n.toLocaleString("en-ZA")} records. Loading it uses ${n.toLocaleString("en-ZA")} of the 50,000 Firestore reads the whole service shares each day. Continue?`,
            confirmText: "Load anyway",
          });
          if (!ok) {
            if (loaded) { fromEl.value = loaded.from; toEl.value = loaded.to; }
            return false;
          }
        }
      }
      await load(from, to);
      loaded = { from, to };
      return true;
    },
  };
}
