// The Home list of each TV, bound to the catalog: its entries as data (what OK would play on each, the new episodes,
// whether the item left the catalog or cannot play), its sections, its app cards (apps of the TV, whatever catalog is
// loaded), and the owner's operations on them. The TV's state (tv.ts) and the admin page (devices.ts) are two
// projections of `list` and `sections`: the TV drops what it cannot play (and the sections left empty), the admin page
// flags it.

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
import { UNTITLED_SECTION, type Cursor, type HomeCard, type HomeSectionWrite, type Progress, type Store, type StoredHomeCard } from "./store.ts";

export { UNTITLED_SECTION, type HomeCard } from "./store.ts";

/** A technical safety limit on every device's home list, not a product rule: Home scrolls past one screen. */
export const HOME_MAX_ITEMS = 200;
/** App cards a Home may hold besides its items. */
export const HOME_MAX_APPS = 50;
/** Sections a Home may have besides the untitled one. */
export const HOME_MAX_SECTIONS = 20;
/** How a section lays out its cards: rows of `homeColumns`, or one line that scrolls sideways. */
export const SECTION_LAYOUTS = ["grid", "row"] as const;
export type SectionLayout = (typeof SECTION_LAYOUTS)[number];
export const SECTION_TITLE_MAX = 40;
/** Per-TV home grid: cards per row and rows per screen (the defaults are the schema's). */
export const HOME_COLUMNS = { min: 3, max: 10, default: 4 } as const;
export const HOME_ROWS = { min: 1, max: 4, default: 2 } as const;

/**
 * A section of a TV's Home: its cards in display order (`entries`), and its items alone (`itemIds`), those gone from
 * the catalog or unplayable included.
 */
export interface Section extends HomeSectionWrite {
  itemIds: string[];
}

/**
 * A section of `PUT …/home {"sections"}`: without `id` a new one; without `layout` it keeps its own. `itemIds` sets its
 * items and keeps its app cards; `entries` sets its cards of both kinds.
 */
export interface SectionInput {
  id?: string;
  title?: string | null;
  layout?: SectionLayout;
  itemIds?: string[];
  entries?: HomeCard[];
}

/** A section as the caller of `PUT …/home {"sections"}` saw it: title and layout compared when given. */
export type ExpectedSection = SectionInput & { id: string };

export interface ItemMove {
  sectionId?: string;
  position?: number;
}

export interface SectionPatch {
  title?: string;
  layout?: SectionLayout;
  position?: number;
}

const isApp = (c: HomeCard): c is { appId: string } => "appId" in c;
const itemIdsOf = (cards: readonly HomeCard[]) => cards.flatMap((c) => (isApp(c) ? [] : [c.itemId]));
const appIdsOf = (cards: readonly HomeCard[]) => cards.flatMap((c) => (isApp(c) ? [c.appId] : []));
const sameCard = (a: HomeCard, b: HomeCard) => (isApp(a) ? isApp(b) && a.appId === b.appId : !isApp(b) && a.itemId === b.itemId);
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const sameCards = (a: readonly HomeCard[], b: readonly HomeCard[]) => a.length === b.length && a.every((c, i) => sameCard(c, b[i]!));
/** A card as answered: exactly its one field. */
const cardOf = (c: HomeCard): HomeCard => (isApp(c) ? { appId: c.appId } : { itemId: c.itemId });
const flat = (sections: readonly HomeSectionWrite[]) => sections.flatMap((s) => itemIdsOf(s.entries));
const copy = (sections: readonly HomeSectionWrite[]): HomeSectionWrite[] => sections.map((s) => ({ ...s, entries: [...s.entries] }));
const present = (sections: readonly HomeSectionWrite[]): Section[] =>
  sections.map(({ id, title, layout, entries }) => ({ id, title, layout, itemIds: itemIdsOf(entries), entries: entries.map(cardOf) }));
const unknownSection = (sectionId: string) => new HttpError(404, "unknown_section", "no such section on this TV's Home", { sectionId });
const notOnHome = (card: HomeCard) => new HttpError(404, "not_on_home", isApp(card) ? "the app is not on this TV's Home" : "the item is not on this TV's home list");
const untitledError = (message: string) => new HttpError(400, "untitled_section", message);

/**
 * `cards` with the app cards of `old` (a section's cards before) put back at their places among the section's cards,
 * at its end when it has fewer now; those in `skip` are left out.
 */
function withAppCards(old: readonly HomeCard[], cards: HomeCard[], skip: ReadonlySet<string> = new Set()): HomeCard[] {
  const out = [...cards];
  old.forEach((c, i) => {
    if (isApp(c) && !skip.has(c.appId)) out.splice(Math.min(i, out.length), 0, c);
  });
  return out;
}

function sectionIn<S extends { id: string }>(sections: S[], sectionId: string): S {
  const found = sections.find((s) => s.id === sectionId);
  if (!found) throw unknownSection(sectionId);
  return found;
}

/** `list` spliced at `position`, clamped to its end. */
function insertAt<T>(list: T[], position: number | undefined, value: T): void {
  list.splice(Math.min(position ?? list.length, list.length), 0, value);
}

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

export interface HomeEntry {
  itemId: string;
  /** Null when it left the catalog (`missing`). */
  item: CatalogItem | null;
  missing: boolean;
  playable: boolean;
  /** Null for a channel or when nothing is playable. */
  continue: Continue | null;
  newEpisodes: number;
  addedAt: number;
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
   * The device's cards as stored, in Home order. A view built of several reads (the list, the sections, the app
   * cards) reads them once and passes them along.
   */
  cards(deviceId: string): StoredHomeCard[] {
    return this.s.store.getHomeCards(deviceId, this.s.catalog.catalogId);
  }

  /** The device's home list in Home order, every entry, those a catalog reload left missing or unplayable included. */
  list(deviceId: string, cards: StoredHomeCard[] = this.cards(deviceId)): HomeEntry[] {
    const { catalog } = this.s;
    const factsFor = this.homeFacts(deviceId);
    return cards.flatMap(({ itemId, addedAt, sectionId }) => (itemId === null ? [] : [{ itemId, addedAt, sectionId }])).map(({ itemId, addedAt, sectionId }) => {
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

  /**
   * The device's sections in display order, each with its cards in Home order; with `keep`, only the cards it keeps
   * (the TV's state: the items it can play, and every app card).
   */
  sections(deviceId: string, keep: (card: HomeCard) => boolean = () => true, cards: StoredHomeCard[] = this.cards(deviceId)): Section[] {
    return present(this.drafts(deviceId, cards)).map((s) => {
      const entries = s.entries.filter(keep);
      return { ...s, itemIds: itemIdsOf(entries), entries };
    });
  }

  /** The device's app cards, in Home order, with the label and picture of the last report that named each. */
  appCards(deviceId: string, cards: StoredHomeCard[] = this.cards(deviceId)): Array<{ appId: string; label: string; image: string | null }> {
    return cards.flatMap((c) =>
      c.appId === null ? [] : [{ appId: c.appId, label: c.appLabel ?? c.appId, image: c.appImage }]);
  }

  /** The sections as stored: each with its cards in order. */
  private drafts(deviceId: string, cards: StoredHomeCard[] = this.cards(deviceId)): HomeSectionWrite[] {
    return this.s.store.getHomeSections(deviceId).map(({ id, title, layout }) => ({
      id, title, layout,
      entries: cards.filter((c) => c.sectionId === id).map((c): HomeCard => (c.appId !== null ? { appId: c.appId } : { itemId: c.itemId! })),
    }));
  }

  /**
   * `PUT …/home {"itemIds"}`: an item already on Home stays in its section, a new one goes to the untitled section,
   * and each section's items follow their order in `itemIds`; its app cards keep their places. With `expected` (the
   * list the caller saw, in Home order), 409 `home_changed` when the list is no longer that, so two editors do not
   * overwrite each other.
   */
  set(deviceId: string, itemIds: string[], actor: Actor, expected?: string[]): number {
    return this.change(deviceId, actor, (before) => {
      if (expected && !sameIds(flat(before), expected)) throw this.changed(before);
      const sectionOf = new Map(before.flatMap((s) => itemIdsOf(s.entries).map((id) => [id, s.id] as const)));
      return before.map((s) => {
        const items = itemIds.filter((id) => (sectionOf.get(id) ?? UNTITLED_SECTION) === s.id).map((itemId) => ({ itemId }));
        return { ...s, entries: withAppCards(s.entries, items) };
      });
    });
  }

  /**
   * `PUT …/home {"sections"}`: a section without `id` is new; a titled section left out is deleted, and its items
   * leave Home unless another section lists them. The untitled section is listed exactly once. A section given with
   * `itemIds` keeps its app cards at their places; one given with `entries` gets exactly those, and an app card that
   * no section lists leaves Home. A deleted section's app cards go to the end of the untitled section, unless that is
   * given with `entries` too.
   */
  setSections(deviceId: string, sections: SectionInput[], actor: Actor, expected?: ExpectedSection[]): number {
    return this.change(deviceId, actor, (before) => {
      if (expected && !this.sameSections(before, expected)) throw this.changed(before);
      const existing = new Map(before.map((s) => [s.id, s]));
      const listedApps = new Set(sections.flatMap((s) => appIdsOf(s.entries ?? [])));
      const cardsOf = (s: SectionInput, id: string) =>
        s.entries ?? withAppCards(existing.get(id)?.entries ?? [], (s.itemIds ?? []).map((itemId) => ({ itemId })), listedApps);
      const listed = new Set<string>();
      let untitled = 0;
      const next = sections.map((s): HomeSectionWrite => {
        if (s.id === UNTITLED_SECTION) {
          untitled++;
          if (typeof s.title === "string") throw untitledError("the untitled section has no title");
          return { id: UNTITLED_SECTION, title: null, layout: s.layout ?? existing.get(UNTITLED_SECTION)!.layout, entries: cardsOf(s, UNTITLED_SECTION) };
        }
        if (s.id !== undefined) {
          if (listed.has(s.id)) throw new HttpError(400, "duplicate_section", "a section appears twice", { sectionId: s.id });
          listed.add(s.id);
          if (!existing.has(s.id)) throw unknownSection(s.id);
        }
        if (typeof s.title !== "string") throw new HttpError(400, "invalid_request", "a section other than the untitled one needs a title");
        const id = s.id ?? this.newSectionId([...existing.values()]);
        if (s.id === undefined) existing.set(id, { id, title: null, layout: "grid", entries: [] });
        return { id, title: s.title.trim(), layout: s.layout ?? existing.get(id)!.layout, entries: cardsOf(s, id) };
      });
      if (untitled !== 1) throw untitledError("the untitled section must be listed exactly once");
      if (!sections.find((s) => s.id === UNTITLED_SECTION)!.entries) {
        const kept = new Set(next.map((s) => s.id));
        const orphans = before.filter((s) => !kept.has(s.id)).flatMap((s) => s.entries.filter((c) => isApp(c) && !listedApps.has(c.appId)));
        sectionIn(next, UNTITLED_SECTION).entries.push(...orphans);
      }
      return next;
    });
  }

  /** Puts the item in a section (default the untitled one) at `position` among its cards (default and upper bound: its end). */
  add(deviceId: string, itemId: string, to: ItemMove, actor: Actor): number {
    return this.addCard(deviceId, { itemId }, to, actor);
  }

  /** Puts an app card on Home, as `add` does an item. */
  addApp(deviceId: string, appId: string, to: ItemMove, actor: Actor): number {
    return this.addCard(deviceId, { appId }, to, actor);
  }

  private addCard(deviceId: string, card: HomeCard, to: ItemMove, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      const next = copy(before);
      insertAt(sectionIn(next, to.sectionId ?? UNTITLED_SECTION).entries, to.position, card);
      return next;
    });
  }

  /** Moves an item to another section and/or position (by default the end of a new section, else where it is). */
  move(deviceId: string, itemId: string, to: ItemMove, actor: Actor): number {
    return this.moveCard(deviceId, { itemId }, to, actor);
  }

  /** Moves an app card, as `move` does an item. */
  moveApp(deviceId: string, appId: string, to: ItemMove, actor: Actor): number {
    return this.moveCard(deviceId, { appId }, to, actor);
  }

  remove(deviceId: string, itemId: string, actor: Actor): number {
    return this.removeCard(deviceId, { itemId }, actor);
  }

  removeApp(deviceId: string, appId: string, actor: Actor): number {
    return this.removeCard(deviceId, { appId }, actor);
  }

  private moveCard(deviceId: string, ref: HomeCard, to: ItemMove, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      const next = copy(before);
      const from = next.find((s) => s.entries.some((c) => sameCard(c, ref)));
      if (!from) throw notOnHome(ref);
      const target = to.sectionId === undefined ? from : sectionIn(next, to.sectionId);
      const index = from.entries.findIndex((c) => sameCard(c, ref));
      const [moved] = from.entries.splice(index, 1);
      insertAt(target.entries, to.position ?? (target === from ? index : undefined), moved!);
      return next;
    });
  }

  private removeCard(deviceId: string, ref: HomeCard, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      if (!before.some((s) => s.entries.some((c) => sameCard(c, ref)))) throw notOnHome(ref);
      return before.map((s) => ({ ...s, entries: s.entries.filter((c) => !sameCard(c, ref)) }));
    });
  }

  /** Adds an empty section at `position` among the sections (default and upper bound: the end). */
  createSection(deviceId: string, title: string, layout: SectionLayout | undefined, position: number | undefined, actor: Actor): { version: number; sectionId: string } {
    let sectionId = "";
    const version = this.change(deviceId, actor, (before) => {
      sectionId = this.newSectionId(before);
      const next = copy(before);
      insertAt(next, position, { id: sectionId, title: title.trim(), layout: layout ?? "grid", entries: [] });
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
        if (section.id === UNTITLED_SECTION) throw untitledError("the untitled section has no title");
        section.title = patch.title.trim();
      }
      if (patch.layout !== undefined) section.layout = patch.layout;
      if (patch.position === undefined) return next;
      const others = next.filter((s) => s !== section);
      insertAt(others, patch.position, section);
      return others;
    });
  }

  /** Deletes a titled section; its cards (items and app cards) move to the end of the untitled section, in their order. */
  deleteSection(deviceId: string, sectionId: string, actor: Actor): number {
    return this.change(deviceId, actor, (before) => {
      const next = copy(before);
      const section = sectionIn(next, sectionId);
      if (section.id === UNTITLED_SECTION) throw untitledError("the untitled section cannot be deleted");
      sectionIn(next, UNTITLED_SECTION).entries.push(...section.entries);
      return next.filter((s) => s !== section);
    });
  }

  /**
   * Every change to a Home, in one transaction: `edit` turns the sections into what they become, checked against the
   * limits. Only items new to the list must be in the catalog and playable: one a catalog reload left missing or
   * unplayable may stay (the TV hides it), so the list can still be reordered or shortened. Likewise only app cards new
   * to Home must be in the TV's last report. Returns the new version.
   */
  private change(deviceId: string, actor: Actor, edit: (before: HomeSectionWrite[]) => HomeSectionWrite[]): number {
    this.s.store.transaction(() => {
      const before = this.drafts(deviceId);
      const next = edit(before);
      const cards = next.flatMap((s) => s.entries);
      const itemIds = itemIdsOf(cards);
      if (itemIds.length > HOME_MAX_ITEMS) {
        throw new HttpError(400, "too_many_items", `a home list holds at most ${HOME_MAX_ITEMS} items`, { max: HOME_MAX_ITEMS });
      }
      const duplicate = itemIds.find((id, i) => itemIds.indexOf(id) !== i);
      if (duplicate !== undefined) throw new HttpError(400, "duplicate_item", "an item appears twice", { itemId: duplicate });
      if (next.filter((s) => s.id !== UNTITLED_SECTION).length > HOME_MAX_SECTIONS) {
        throw new HttpError(400, "too_many_sections", `a Home has at most ${HOME_MAX_SECTIONS} sections besides the untitled one`, { max: HOME_MAX_SECTIONS });
      }
      const appIds = appIdsOf(cards);
      const twice = appIds.find((id, i) => appIds.indexOf(id) !== i);
      if (twice !== undefined) throw new HttpError(400, "duplicate_app", "an app card appears twice", { appId: twice });
      if (appIds.length > HOME_MAX_APPS) {
        throw new HttpError(400, "too_many_apps", `a Home holds at most ${HOME_MAX_APPS} app cards`, { max: HOME_MAX_APPS });
      }
      const was = new Set(flat(before));
      for (const id of itemIds) {
        if (was.has(id)) continue;
        const item = this.s.catalog.item(id);
        if (!item) throw new HttpError(400, "unknown_item", "no such item in the catalog", { itemId: id });
        if (!isPlayable(item)) throw new HttpError(400, "not_playable", "the item has no episode with playback allowed, or is a channel whose playback is not allowed", { itemId: id });
      }
      const appsWere = new Set(before.flatMap((s) => appIdsOf(s.entries)));
      const reported = new Set(this.s.store.getDeviceApps(deviceId).map((a) => a.appId));
      const unknown = appIds.find((id) => !appsWere.has(id) && !reported.has(id));
      if (unknown !== undefined) throw new HttpError(400, "unknown_app", "the TV's last list of its apps does not name this app", { appId: unknown });
      this.s.store.setHome(deviceId, this.s.catalog.catalogId, next, this.s.now());
      this.s.eventLog.append("home.changed", deviceId, actor, {
        itemIds, added: itemIds.filter((id) => !was.has(id)), removed: [...was].filter((id) => !itemIds.includes(id)),
        appIds, appsAdded: appIds.filter((id) => !appsWere.has(id)), appsRemoved: [...appsWere].filter((id) => !appIds.includes(id)),
      });
    });
    return this.s.notifier.bump(deviceId);
  }

  private changed(before: HomeSectionWrite[]): HttpError {
    return new HttpError(409, "home_changed", "the home list changed in the meantime", { itemIds: flat(before), sections: present(before) });
  }

  /**
   * Whether the Home is the one the caller saw: the same sections in order, with the same items (or, given `entries`,
   * the same cards), titles and layouts when given.
   */
  private sameSections(before: HomeSectionWrite[], expected: ExpectedSection[]): boolean {
    return before.length === expected.length && before.every((s, i) => {
      const e = expected[i]!;
      const same = (e.entries === undefined || sameCards(s.entries, e.entries)) &&
        ((e.itemIds === undefined && e.entries !== undefined) || sameIds(itemIdsOf(s.entries), e.itemIds ?? []));
      return s.id === e.id && same && (e.title === undefined || e.title === s.title) && (e.layout === undefined || e.layout === s.layout);
    });
  }

  /** A new section id: 8 alphanumeric characters, none of the Home's. */
  private newSectionId(taken: readonly HomeSectionWrite[]): string {
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

  private itemFacts(deviceId: string, itemId: string): ItemFacts {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    return {
      progress: new Map(store.listProgress(deviceId, catalogId, itemId).map((p) => [p.episodeId, p])),
      cursor: store.getCursor(deviceId, catalogId, itemId),
      seenAfter: (sinceMs) => store.episodesSeenAfter(catalogId, itemId, sinceMs),
    };
  }

  /** The same facts for every item of a device's home list, read in three queries rather than a few per item. */
  private homeFacts(deviceId: string): (itemId: string) => ItemFacts {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    const progress = new Map<string, Map<string, Progress>>();
    for (const p of store.listProgress(deviceId, catalogId)) {
      progress.set(p.itemId, (progress.get(p.itemId) ?? new Map<string, Progress>()).set(p.episodeId, p));
    }
    const cursors = new Map(store.listCursors(deviceId, catalogId).map((c) => [c.itemId, c]));
    const seen = store.listSeen(catalogId);
    return (itemId) => ({
      progress: progress.get(itemId) ?? new Map(),
      cursor: cursors.get(itemId) ?? null,
      seenAfter: (sinceMs) => (seen.get(itemId) ?? []).filter((e) => e.firstSeenAt > sinceMs).map((e) => e.episodeId),
    });
  }

  /** After the item was watched to the end (a wrapped cursor), episodes the catalog gained since then come first. */
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
   * report on the item and the moment the item went on its home list. The history's baseline never counts.
   */
  private newEpisodesWith(item: EpisodicItem, addedAt: number, facts: ItemFacts): number {
    const lastProgressAt = Math.max(0, ...[...facts.progress.values()].map((p) => p.updatedAt));
    const added = facts.seenAfter(Math.max(lastProgressAt, addedAt));
    const allowed = new Set(item.episodes.filter((e) => e.playbackAllowed).map((e) => e.id));
    return added.filter((id) => allowed.has(id)).length;
  }
}
