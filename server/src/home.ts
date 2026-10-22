// The Home list of each TV, bound to the catalog: its entries as data (what OK would play on each, the new episodes,
// whether the item left the catalog or cannot play), its sections, and the owner's operations on it (the whole
// list, one item added, moved or removed, a section created, changed or deleted, the "continue from" override). The
// TV's state (tv.ts) and the admin page (devices.ts) are two projections of `list` and `sections`: the TV drops what
// it cannot play (and the sections left empty), the admin page flags it.

import { isLiveItem, type CatalogItem, type EpisodicItem } from "@izle/contract";
import type { Actor } from "./actor.ts";
import { newId } from "./auth.ts";
import type { CatalogService } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { Notifier } from "./events.ts";
import { requireEpisodicItem, requirePlayable } from "./lookup.ts";
import { cursorIndex, isPlayable } from "./playback.ts";
import { episodeSummary } from "./presenters.ts";
import { UNTITLED_SECTION, type Cursor, type HomeSectionWrite, type Progress, type Store } from "./store.ts";

export { UNTITLED_SECTION } from "./store.ts";

/** A technical safety limit on every device's home list, not a product rule: Home scrolls past one screen. */
export const HOME_MAX_ITEMS = 200;

/** Sections a Home may have besides the untitled one (`sectionsMax`). */
export const HOME_MAX_SECTIONS = 20;

/** How a section lays out its cards: rows of `homeColumns`, or one line that scrolls sideways. */
export const SECTION_LAYOUTS = ["grid", "row"] as const;
export type SectionLayout = (typeof SECTION_LAYOUTS)[number];

/** A section title's length, in characters (trimmed, with a non-space). */
export const SECTION_TITLE_MAX = 40;

/**
 * A section of a TV's Home with its items in display order, those gone from the catalog or unplayable included.
 * `title` is null for the untitled section.
 */
export type Section = HomeSectionWrite;

/** A section of `PUT …/home {"sections"}`: without `id` a new one; without `layout` it keeps its own. */
export interface SectionInput {
  id?: string;
  title?: string | null;
  layout?: SectionLayout;
  itemIds: string[];
}

/** A section as the caller of `PUT …/home {"sections"}` saw it (`expected`): title and layout compared when given. */
export interface ExpectedSection {
  id: string;
  title?: string | null;
  layout?: SectionLayout;
  itemIds: string[];
}

/** What a single item change does: the section it goes to and its position there. */
export interface ItemMove {
  sectionId?: string;
  position?: number;
}

/** What a section change sets. */
export interface SectionPatch {
  title?: string;
  layout?: SectionLayout;
  position?: number;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const flat = (sections: readonly Section[]) => sections.flatMap((s) => s.itemIds);
const copy = (sections: readonly Section[]): Section[] => sections.map((s) => ({ ...s, itemIds: [...s.itemIds] }));
const unknownSection = (sectionId: string) => new HttpError(404, "unknown_section", "no such section on this TV's Home", { sectionId });
const notOnHome = () => new HttpError(404, "not_on_home", "the item is not on this TV's home list");

/** The section of `sections` with this id; 404 `unknown_section` otherwise. */
function sectionIn(sections: Section[], sectionId: string): Section {
  const found = sections.find((s) => s.id === sectionId);
  if (!found) throw unknownSection(sectionId);
  return found;
}

/** `list` spliced at `position`, clamped to its end. */
function insertAt<T>(list: T[], position: number | undefined, value: T): void {
  list.splice(Math.min(position ?? list.length, list.length), 0, value);
}

/** Per-TV home grid: cards per row and rows per screen (the owner's setting; the defaults are the schema's). */
export const HOME_COLUMNS = { min: 3, max: 6, default: 4 } as const;
export const HOME_ROWS = { min: 1, max: 4, default: 2 } as const;

/** What the device saved about one item: positions by episode, the play cursor, and the episodes new since a time. */
interface ItemFacts {
  progress: Map<string, Progress>;
  cursor: Cursor | null;
  /** The item's present episodes that first appeared after `sinceMs`, oldest first. */
  seenAfter: (sinceMs: number) => string[];
}

/** The episode OK plays for an item and where it starts. */
export interface Continue extends ReturnType<typeof episodeSummary> {
  episodeId: string;
  index: number;
  count: number;
  positionMs: number;
  durationMs: number | null;
  status: Progress["status"] | "new";
}

/** One entry of a TV's home list, as data: what OK would play and whether it can. */
export interface HomeEntry {
  itemId: string;
  /** The catalog item; null when it left the catalog (`missing`). */
  item: CatalogItem | null;
  missing: boolean;
  playable: boolean;
  /** What OK plays and where it starts; null for a channel or when nothing is playable. */
  continue: Continue | null;
  newEpisodes: number;
  addedAt: number;
  /** The section it is in. */
  sectionId: string;
}

interface HomeDeps {
  store: Store;
  catalog: CatalogService;
  eventLog: EventLog;
  notifier: Notifier;
  now: () => number;
}

export class HomeService {
  private readonly s: HomeDeps;

  constructor(deps: HomeDeps) {
    this.s = deps;
  }

  /**
   * The device's home list in Home order, every entry: items gone after a catalog reload are `missing`, items
   * nothing of which may play are not `playable`. A channel has no `continue` and no new episodes.
   */
  list(deviceId: string): HomeEntry[] {
    const { store, catalog } = this.s;
    const factsFor = this.homeFacts(deviceId);
    return store.getHomeEntries(deviceId, catalog.catalogId).map(({ itemId, addedAt, sectionId }) => {
      const item = catalog.item(itemId);
      if (!item) return { itemId, item: null, missing: true, playable: false, continue: null, newEpisodes: 0, addedAt, sectionId };
      const entry = { itemId, item, missing: false, playable: isPlayable(item), continue: null, newEpisodes: 0, addedAt, sectionId };
      if (isLiveItem(item)) return entry;
      const facts = factsFor(item.id);
      return { ...entry, continue: this.continueWith(item, facts), newEpisodes: this.newEpisodesWith(item, addedAt, facts) };
    });
  }

  /** What OK would play for the item on this device right now; null when nothing is playable. */
  continueFor(deviceId: string, item: EpisodicItem): Continue | null {
    return this.continueWith(item, this.itemFacts(deviceId, item.id));
  }

  /** The hidden menu's view of an item on this device: the saved position of each episode, and what OK would play. */
  itemProgress(deviceId: string, item: EpisodicItem): { progress: ReadonlyMap<string, Progress>; continue: Continue | null } {
    const facts = this.itemFacts(deviceId, item.id);
    return { progress: facts.progress, continue: this.continueWith(item, facts) };
  }

  /** The device's home list as item ids, in Home order (items gone from the catalog included). */
  ids(deviceId: string): string[] {
    return this.s.store.getHomeEntries(deviceId, this.s.catalog.catalogId).map((e) => e.itemId);
  }

  /** The device's sections in display order, always with the untitled one, each with all its items. */
  sections(deviceId: string): Section[] {
    return this.sectionsOf(deviceId, this.s.store.getHomeEntries(deviceId, this.s.catalog.catalogId));
  }

  /** The device's sections in display order, each with the ids of those `entries` (in Home order) that are in it. */
  sectionsOf(deviceId: string, entries: ReadonlyArray<{ itemId: string; sectionId: string }>): Section[] {
    return this.s.store.getHomeSections(deviceId).map(({ id, title, layout }) => ({
      id, title, layout, itemIds: entries.filter((e) => e.sectionId === id).map((e) => e.itemId),
    }));
  }

  /**
   * Sets which items are on Home and their order (`PUT …/home {"itemIds"}`), keeping the sections: an item already
   * on Home stays in its section, a new one goes to the untitled section, and each section's items follow their order
   * in `itemIds`. With `expected` (the list the caller saw, in Home order), answers 409 `home_changed` when the list
   * is no longer that, so two editors do not overwrite each other. Returns the new state version.
   */
  set(deviceId: string, itemIds: string[], actor: Actor, expected?: string[]): number {
    return this.change(deviceId, actor, (before) => {
      if (expected && !sameIds(flat(before), expected)) throw this.changed(before);
      const sectionOf = new Map(before.flatMap((s) => s.itemIds.map((id) => [id, s.id] as const)));
      return before.map((s) => ({ ...s, itemIds: itemIds.filter((id) => (sectionOf.get(id) ?? UNTITLED_SECTION) === s.id) }));
    });
  }

  /**
   * Replaces the whole Home (`PUT …/home {"sections"}`), sections in display order. A section without `id` is new; a
   * titled section left out is deleted, and its items leave Home unless another section lists them. The untitled
   * section is listed exactly once (400 `untitled_section`). With `expected` (the sections the caller saw), 409
   * `home_changed` when the Home is no longer that.
   */
  setSections(deviceId: string, sections: SectionInput[], actor: Actor, expected?: ExpectedSection[]): number {
    return this.change(deviceId, actor, (before) => {
      if (expected && !this.sameSections(before, expected)) throw this.changed(before);
      const existing = new Map(before.map((s) => [s.id, s]));
      const listed = new Set<string>();
      let untitled = 0;
      const next = sections.map((s): Section => {
        if (s.id === UNTITLED_SECTION) {
          untitled++;
          if (typeof s.title === "string") throw new HttpError(400, "untitled_section", "the untitled section has no title");
          return { id: UNTITLED_SECTION, title: null, layout: s.layout ?? existing.get(UNTITLED_SECTION)!.layout, itemIds: s.itemIds };
        }
        if (s.id !== undefined) {
          if (listed.has(s.id)) throw new HttpError(400, "duplicate_section", "a section appears twice", { sectionId: s.id });
          listed.add(s.id);
          if (!existing.has(s.id)) throw unknownSection(s.id);
        }
        if (typeof s.title !== "string") throw new HttpError(400, "invalid_request", "a section other than the untitled one needs a title");
        const id = s.id ?? this.newSectionId([...existing.values()]);
        if (s.id === undefined) existing.set(id, { id, title: null, layout: "grid", itemIds: [] });
        return { id, title: s.title.trim(), layout: s.layout ?? existing.get(id)!.layout, itemIds: s.itemIds };
      });
      if (untitled !== 1) throw new HttpError(400, "untitled_section", "the untitled section must be listed exactly once");
      return next;
    });
  }

  /** Puts the item in a section (default the untitled one) at `position` (0-based; default and upper bound: its end). */
  add(deviceId: string, itemId: string, to: ItemMove, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      const next = copy(before);
      insertAt(sectionIn(next, to.sectionId ?? UNTITLED_SECTION).itemIds, to.position, itemId);
      return next;
    });
  }

  /**
   * Moves an item of the list to another section and/or position (0-based within the section it ends up in, clamped
   * to its end; the end by default when the section changes, else where it is).
   */
  move(deviceId: string, itemId: string, to: ItemMove, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      const next = copy(before);
      const from = next.find((s) => s.itemIds.includes(itemId));
      if (!from) throw notOnHome();
      const target = to.sectionId === undefined ? from : sectionIn(next, to.sectionId);
      const index = from.itemIds.indexOf(itemId);
      from.itemIds.splice(index, 1);
      insertAt(target.itemIds, to.position ?? (target === from ? index : undefined), itemId);
      return next;
    });
  }

  remove(deviceId: string, itemId: string, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      if (!flat(before).includes(itemId)) throw notOnHome();
      return before.map((s) => ({ ...s, itemIds: s.itemIds.filter((id) => id !== itemId) }));
    });
  }

  /** Adds an empty section at `position` among the sections (default and upper bound: the end). */
  createSection(deviceId: string, title: string, layout: SectionLayout | undefined, position: number | undefined, actor: Actor): { version: number; sectionId: string } {
    let sectionId = "";
    const version = this.change(deviceId, actor, (before) => {
      sectionId = this.newSectionId(before);
      const next = copy(before);
      insertAt(next, position, { id: sectionId, title: title.trim(), layout: layout ?? "grid", itemIds: [] });
      return next;
    });
    return { version, sectionId };
  }

  /** Retitles, lays out or moves a section (`position` clamped to the end). The untitled section takes no title. */
  updateSection(deviceId: string, sectionId: string, patch: SectionPatch, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      const next = copy(before);
      const section = sectionIn(next, sectionId);
      if (patch.title !== undefined) {
        if (section.id === UNTITLED_SECTION) throw new HttpError(400, "untitled_section", "the untitled section has no title");
        section.title = patch.title.trim();
      }
      if (patch.layout !== undefined) section.layout = patch.layout;
      if (patch.position === undefined) return next;
      const others = next.filter((s) => s !== section);
      insertAt(others, patch.position, section);
      return others;
    });
  }

  /** Deletes a titled section; its items move to the end of the untitled section, in their order. */
  deleteSection(deviceId: string, sectionId: string, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      const next = copy(before);
      const section = sectionIn(next, sectionId);
      if (section.id === UNTITLED_SECTION) throw new HttpError(400, "untitled_section", "the untitled section cannot be deleted");
      sectionIn(next, UNTITLED_SECTION).itemIds.push(...section.itemIds);
      return next.filter((s) => s !== section);
    });
  }

  /**
   * Every change to a Home, in one transaction: `edit` turns the sections as they are into what they become, which
   * must hold at most HOME_MAX_ITEMS items, each once, and at most HOME_MAX_SECTIONS sections besides the untitled
   * one. Only items new to the list must be in the catalog and playable: one a catalog reload left missing or
   * unplayable may stay (the TV hides it), so the list can still be reordered or shortened. Emits `home.changed`
   * (`itemIds` in Home order) and returns the new state version.
   */
  private change(deviceId: string, actor: Actor, edit: (before: Section[]) => Section[]): number {
    this.s.store.transaction(() => {
      const before = this.sections(deviceId);
      const next = edit(before);
      const itemIds = flat(next);
      if (itemIds.length > HOME_MAX_ITEMS) {
        throw new HttpError(400, "too_many_items", `a home list holds at most ${HOME_MAX_ITEMS} items`, { max: HOME_MAX_ITEMS });
      }
      const seen = new Set<string>();
      for (const id of itemIds) {
        if (seen.has(id)) throw new HttpError(400, "duplicate_item", "an item appears twice", { itemId: id });
        seen.add(id);
      }
      if (next.filter((s) => s.id !== UNTITLED_SECTION).length > HOME_MAX_SECTIONS) {
        throw new HttpError(400, "too_many_sections", `a Home has at most ${HOME_MAX_SECTIONS} sections besides the untitled one`, { max: HOME_MAX_SECTIONS });
      }
      const was = new Set(flat(before));
      for (const id of itemIds) {
        if (was.has(id)) continue;
        const item = this.s.catalog.item(id);
        if (!item) throw new HttpError(400, "unknown_item", "no such item in the catalog", { itemId: id });
        if (!isPlayable(item)) throw new HttpError(400, "not_playable", "the item has no episode with playback allowed, or is a channel whose playback is not allowed", { itemId: id });
      }
      this.s.store.setHome(deviceId, this.s.catalog.catalogId, next, this.s.now());
      this.s.eventLog.append("home.changed", deviceId, actor, { itemIds, added: itemIds.filter((id) => !was.has(id)), removed: [...was].filter((id) => !seen.has(id)) });
    });
    return this.s.notifier.bump(deviceId);
  }

  /** 409 `home_changed`, with the Home as it is now. */
  private changed(before: Section[]): HttpError {
    return new HttpError(409, "home_changed", "the home list changed in the meantime", { itemIds: flat(before), sections: before });
  }

  /** Whether the Home is the one the caller saw: the same sections in order, with the same items (titles and layouts when given). */
  private sameSections(before: Section[], expected: ExpectedSection[]): boolean {
    return before.length === expected.length && before.every((s, i) => {
      const e = expected[i]!;
      return s.id === e.id && sameIds(s.itemIds, e.itemIds) && (e.title === undefined || e.title === s.title) && (e.layout === undefined || e.layout === s.layout);
    });
  }

  /** A new section id: 8 alphanumeric characters, none of the Home's. */
  private newSectionId(taken: readonly Section[]): string {
    const used = new Set(taken.map((s) => s.id));
    for (;;) {
      const id = newId(8);
      if (id !== UNTITLED_SECTION && !used.has(id)) return id;
    }
  }

  /**
   * Owner override "continue from episode X": moves the cursor (an ordinary one, so it wins over episodes added
   * after a wrap) and forgets X's saved position so it starts over. A channel has no cursor (400 `unknown_episode`).
   */
  setCursor(deviceId: string, itemId: string, episodeId: string, actor: Actor): number {
    const item = requireEpisodicItem(this.s.catalog, itemId, 404, "unknown_item");
    const episode = item.episodes.find((e) => e.id === episodeId);
    if (!episode) throw new HttpError(400, "unknown_episode", "the episode does not belong to this item");
    requirePlayable(episode, 400, "not_allowed");
    const catalogId = this.s.catalog.catalogId;
    this.s.store.transaction(() => {
      this.s.store.setCursor(deviceId, { catalogId, itemId, episodeId, updatedAt: this.s.now() });
      this.s.store.deleteProgress(deviceId, catalogId, episodeId);
      this.s.eventLog.append("cursor.changed", deviceId, actor, { itemId, episodeId });
    });
    return this.s.notifier.bump(deviceId);
  }

  /** What the device saved about one item, a few queries. */
  private itemFacts(deviceId: string, itemId: string): ItemFacts {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    return {
      progress: new Map(store.listProgress(deviceId, catalogId, itemId).map((p) => [p.episodeId, p])),
      cursor: store.getCursor(deviceId, catalogId, itemId),
      seenAfter: (sinceMs) => store.episodesSeenAfter(catalogId, itemId, sinceMs),
    };
  }

  /**
   * The same facts for every item of a device's home list (up to HOME_MAX_ITEMS), read in three queries rather than
   * a few per item.
   */
  private homeFacts(deviceId: string): (itemId: string) => ItemFacts {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    const progress = new Map<string, Map<string, Progress>>();
    for (const p of store.listProgress(deviceId, catalogId)) {
      const byEpisode = progress.get(p.itemId) ?? new Map<string, Progress>();
      progress.set(p.itemId, byEpisode.set(p.episodeId, p));
    }
    const cursors = new Map(store.listCursors(deviceId, catalogId).map((c) => [c.itemId, c]));
    const seen = store.listSeen(catalogId);
    return (itemId) => ({
      progress: progress.get(itemId) ?? new Map(),
      cursor: cursors.get(itemId) ?? null,
      seenAfter: (sinceMs) => (seen.get(itemId) ?? []).filter((e) => e.firstSeenAt > sinceMs).map((e) => e.episodeId),
    });
  }

  /**
   * The episode OK would play for this item and where it would start. Null when nothing is playable. After the
   * item was watched to the end (a wrapped cursor), episodes the catalog gained since then come first.
   */
  private continueWith(item: EpisodicItem, facts: ItemFacts): Continue | null {
    const { progress, cursor } = facts;
    const appended = cursor?.wrapped ? new Set(facts.seenAfter(cursor.updatedAt)) : undefined;
    const index = cursorIndex(item, cursor, progress, appended);
    if (index < 0) return null;
    const episode = item.episodes[index]!;
    const p = progress.get(episode.id);
    const status = p?.status ?? "new";
    const positionMs = status === "watching" ? p!.positionMs : 0;
    const durationMs = p?.durationMs ?? episode.durationMs ?? null;
    return { episodeId: episode.id, ...episodeSummary(episode), index, count: item.episodes.length, positionMs, durationMs, status };
  }

  /**
   * How many episodes of the item with playbackAllowed entered the catalog after both the device's last progress
   * report on the item and the moment the item went on its home list (`addedAt`). Episodes of the first load of
   * the catalog (the history's baseline) never count.
   */
  private newEpisodesWith(item: EpisodicItem, addedAt: number, facts: ItemFacts): number {
    const lastProgressAt = Math.max(0, ...[...facts.progress.values()].map((p) => p.updatedAt));
    const added = facts.seenAfter(Math.max(lastProgressAt, addedAt));
    const allowed = new Set(item.episodes.filter((e) => e.playbackAllowed).map((e) => e.id));
    return added.filter((id) => allowed.has(id)).length;
  }
}
